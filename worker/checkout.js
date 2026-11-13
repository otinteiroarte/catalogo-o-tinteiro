/**
 * O Tinteiro — função de pagamento (Cloudflare Worker).
 *
 * Recebe o carrinho do site, confere cada preço no produtos.json publicado do próprio site
 * (o navegador nunca decide o valor) e devolve o link de pagamento do Mercado Pago (Checkout Pro:
 * Pix, cartão de crédito e débito).
 *
 * Variáveis (Cloudflare → Workers → Settings → Variables):
 *   MP_ACCESS_TOKEN  (secreta)  Access Token do Mercado Pago. Comece pelo de TESTE.
 *   SITE_URL                    Endereço(s) do site, sem barra no fim, separados por vírgula (ex.: a prévia e o site
 *                               definitivo). O site informa qual é o seu; vale o primeiro quando não informa.
 *   ORIGENS_PERMITIDAS          Opcional. Origens aceitas, separadas por vírgula. Padrão: as origens do SITE_URL.
 *   ANEXOS_DIAS                 Opcional. Dias que as imagens dos clientes ficam guardadas (padrão 180). Uma vez por dia
 *                               a própria função apaga as mais antigas.
 *
 * Imagem própria do cliente (opcional): ligue um bucket R2 com o nome de variável ANEXOS
 * (veja wrangler.toml). Sem ele, o site pede ao cliente que envie a imagem pelo WhatsApp.
 *   POST /anexo           recebe o arquivo (campo "arquivo") e devolve { link }
 *   GET  /anexo/<chave>   mostra o arquivo para a loja (endereço impossível de adivinhar)
 *
 * Confirmação do pagamento:
 *   GET  /pagamento?id=<número>   pergunta ao Mercado Pago a situação do pagamento e devolve só
 *                                 { status, referencia }. O site usa isso antes de mostrar "aprovado".
 *
 * Proteção contra robôs (opcional):
 *   TURNSTILE_SECRET  (secreta)  Chave secreta do Turnstile da Cloudflare. Com ela, o pedido de pagamento
 *                                só é aceito com a verificação feita no site (VITE_TURNSTILE_SITEKEY).
 *   Além disso, o campo invisível "armadilha" recusa formulários preenchidos por robôs.
 *
 * Frete pelo Melhor Envio (opcional):
 *   MELHOR_ENVIO_TOKEN       (secreta)  Token de acesso gerado no painel do Melhor Envio (Integrações).
 *   MELHOR_ENVIO_USER_AGENT             Nome da aplicação e e-mail técnico, exigido pelo Melhor Envio.
 *                                       Ex.: "O Tinteiro (email-da-loja@exemplo.com)".
 *   MELHOR_ENVIO_SANDBOX                "sim" para usar o ambiente de testes do Melhor Envio.
 *   No produtos.json, loja.frete precisa de cepOrigem e das medidas do pacote (loja.frete.pacote).
 *   POST /frete   { cep, itens } → opções { id, nome, empresa, preco, prazo }.
 *   No pagamento, o frete escolhido é cotado de novo aqui; o preço enviado pelo navegador é ignorado.
 */

const ANEXO_TIPOS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};
const ANEXO_LIMITE = 10 * 1024 * 1024;
const CHAVE_ANEXO = /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif|pdf)$/;

const LIMITE_UNIDADES = 1500;

/** Frete configurado no produtos.json? (CEP de origem e medidas do pacote preenchidos) */
function freteConfigurado(loja) {
  const f = loja?.frete;
  const p = f?.pacote;
  return (
    f?.modo === 'melhorenvio' &&
    /^\d{8}$/.test(String(f.cepOrigem || '').replace(/\D/g, '')) &&
    [p?.unidades, p?.pesoKg, p?.larguraCm, p?.alturaCm, p?.comprimentoCm].every((v) => Number(v) > 0)
  );
}

/**
 * Cota o frete no Melhor Envio. Cada linha do carrinho vira pacotes do tamanho configurado
 * (30 santinhos por pacote; uma quantidade avulsa conta como um pacote).
 */
async function cotarFrete(env, loja, cepDestino, linhas) {
  const f = loja.frete;
  const p = f.pacote;
  const pacotes = linhas.reduce((n, l) => n + Math.ceil(l.unidades / Number(p.unidades)), 0);
  const valor = linhas.reduce((s, l) => s + l.unidades * l.precoUnitario, 0);
  const base = env.MELHOR_ENVIO_SANDBOX === 'sim' ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br';
  const r = await fetch(`${base}/api/v2/me/shipment/calculate`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MELHOR_ENVIO_TOKEN}`,
      'User-Agent': env.MELHOR_ENVIO_USER_AGENT,
    },
    body: JSON.stringify({
      from: { postal_code: String(f.cepOrigem).replace(/\D/g, '') },
      to: { postal_code: cepDestino },
      products: [
        {
          id: 'pacote-santinhos',
          width: Number(p.larguraCm),
          height: Number(p.alturaCm),
          length: Number(p.comprimentoCm),
          weight: Number(p.pesoKg),
          insurance_value: Math.round((valor / pacotes) * 100) / 100,
          quantity: pacotes,
        },
      ],
      options: { receipt: false, own_hand: false },
    }),
  });
  const dados = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(dados)) {
    console.log('Melhor Envio recusou a cotação', r.status, JSON.stringify(dados));
    return null;
  }
  return dados
    .filter((o) => !o.error && Number(o.custom_price ?? o.price) > 0)
    .map((o) => ({
      id: String(o.id),
      nome: String(o.name || ''),
      empresa: String(o.company?.name || ''),
      preco: Math.round(Number(o.custom_price ?? o.price) * 100) / 100,
      prazo: Number(o.custom_delivery_time ?? o.delivery_time) || null,
    }))
    .sort((a, b) => a.preco - b.preco);
}

/** Confere os itens do carrinho contra o catálogo. Devolve { linhas } ou { erro, status }. */
function conferirItens(itensPedido, catalogo) {
  const { loja, produtos } = catalogo;
  const linhas = [];
  for (const item of Array.isArray(itensPedido) ? itensPedido : []) {
    const produto = produtos.find((p) => p.id === item.produtoId);
    const unidades = Number(item.unidades);
    const precoUnitario = Number(produto?.precoUnitario);
    if (!produto || !produto.disponivel) return { erro: 'Um dos santinhos não está disponível.', status: 400 };
    if (!Number.isInteger(unidades) || unidades < 1 || unidades > LIMITE_UNIDADES) return { erro: 'Quantidade inválida.', status: 400 };
    if (!(precoUnitario > 0)) return { erro: 'Preço indisponível.', status: 502 };
    if (!loja.papeis.includes(item.papel)) return { erro: 'Papel inválido.', status: 400 };
    linhas.push({ item, produto, unidades, precoUnitario });
  }
  if (linhas.length === 0) return { erro: 'O carrinho está vazio.', status: 400 };
  return { linhas };
}

/** Endereços do site aceitos (SITE_URL pode ter mais de um, separados por vírgula). */
const basesDoSite = (env) =>
  String(env.SITE_URL || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
const escolherBase = (env, pedida) => {
  const bases = basesDoSite(env);
  const p = String(pedida || '').replace(/\/$/, '');
  return bases.includes(p) ? p : bases[0];
};

/** Apaga as imagens dos clientes mais antigas que ANEXOS_DIAS (padrão 180). Roda uma vez por dia. */
async function limparAnexosAntigos(env, agora = Date.now()) {
  if (!env.ANEXOS) return 0;
  const dias = Number(env.ANEXOS_DIAS) > 0 ? Number(env.ANEXOS_DIAS) : 180;
  const limite = agora - dias * 24 * 60 * 60 * 1000;
  let cursor;
  let apagados = 0;
  do {
    const lista = await env.ANEXOS.list({ cursor, limit: 1000 });
    const velhos = lista.objects.filter((o) => new Date(o.uploaded).getTime() < limite).map((o) => o.key);
    if (velhos.length) {
      await env.ANEXOS.delete(velhos);
      apagados += velhos.length;
    }
    cursor = lista.truncated ? lista.cursor : undefined;
  } while (cursor);
  return apagados;
}

const cepValido = (v) => {
  const cep = String(v || '').replace(/\D/g, '');
  return /^\d{8}$/.test(cep) ? cep : null;
};

export default {
  async fetch(request, env) {
    const origem = request.headers.get('Origin') || '';
    const bases = basesDoSite(env);
    const permitidas = (env.ORIGENS_PERMITIDAS ? env.ORIGENS_PERMITIDAS.split(',') : bases.map((b) => new URL(b).origin))
      .map((o) => o.trim())
      .filter((o, i, todas) => o && todas.indexOf(o) === i);
    const cors = {
      'Access-Control-Allow-Origin': permitidas.includes(origem) ? origem : permitidas[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    const responder = (corpo, status = 200) =>
      new Response(JSON.stringify(corpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // A loja abre o anexo pelo link que chega no pedido.
    if (request.method === 'GET' && url.pathname.startsWith('/anexo/')) {
      const chave = decodeURIComponent(url.pathname.slice('/anexo/'.length));
      if (!env.ANEXOS || !CHAVE_ANEXO.test(chave)) return new Response('Não encontrado.', { status: 404 });
      const objeto = await env.ANEXOS.get(chave);
      if (!objeto) return new Response('Não encontrado.', { status: 404 });
      return new Response(objeto.body, {
        headers: {
          'Content-Type': objeto.httpMetadata?.contentType || 'application/octet-stream',
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    // O site confirma o pagamento antes de mostrar "aprovado".
    if (request.method === 'GET' && url.pathname === '/pagamento') {
      if (!permitidas.includes(origem)) return responder({ erro: 'Origem não autorizada.' }, 403);
      if (!env.MP_ACCESS_TOKEN) return responder({ erro: 'Pagamento ainda não configurado.' }, 503);
      const id = url.searchParams.get('id') || '';
      if (!/^\d{1,20}$/.test(id)) return responder({ erro: 'Pagamento inválido.' }, 400);
      const mp = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
      });
      if (mp.status === 404) return responder({ erro: 'Pagamento não encontrado.' }, 404);
      const p = await mp.json().catch(() => ({}));
      if (!mp.ok) return responder({ erro: 'O Mercado Pago não respondeu como esperado.' }, 502);
      // Só o necessário: nada de dados do comprador ou do cartão.
      return responder({ status: String(p.status || ''), referencia: String(p.external_reference || '') });
    }

    if (request.method !== 'POST') return responder({ erro: 'Método não permitido.' }, 405);
    if (!permitidas.includes(origem)) return responder({ erro: 'Origem não autorizada.' }, 403);

    // Recebe a imagem própria do cliente.
    if (url.pathname === '/anexo') {
      if (!env.ANEXOS) return responder({ erro: 'Envio de imagens ainda não configurado.' }, 503);
      let arquivo;
      try {
        arquivo = (await request.formData()).get('arquivo');
      } catch {
        return responder({ erro: 'Arquivo inválido.' }, 400);
      }
      if (!arquivo || typeof arquivo === 'string') return responder({ erro: 'Nenhum arquivo enviado.' }, 400);
      const extensao = ANEXO_TIPOS[arquivo.type];
      if (!extensao) return responder({ erro: 'Envie uma foto (JPG, PNG, WEBP ou HEIC) ou um PDF.' }, 415);
      if (arquivo.size > ANEXO_LIMITE) return responder({ erro: 'Arquivo acima de 10 MB.' }, 413);
      const chave = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extensao}`;
      await env.ANEXOS.put(chave, arquivo.stream(), {
        httpMetadata: { contentType: arquivo.type },
        customMetadata: { nome: String(arquivo.name || '').slice(0, 120) },
      });
      return responder({ link: `${url.origin}/anexo/${chave}` });
    }

    // Cotação de frete (funciona mesmo antes de o pagamento ser ligado).
    if (url.pathname === '/frete') {
      if (!bases.length || !env.MELHOR_ENVIO_TOKEN || !env.MELHOR_ENVIO_USER_AGENT) {
        return responder({ erro: 'Frete ainda não configurado.' }, 503);
      }
      let corpo;
      try {
        corpo = await request.json();
      } catch {
        return responder({ erro: 'Pedido inválido.' }, 400);
      }
      const cep = cepValido(corpo?.cep);
      if (!cep) return responder({ erro: 'Confira o CEP (8 números).' }, 400);
      const rc = await fetch(`${escolherBase(env, corpo?.site)}/produtos.json`, { cf: { cacheTtl: 60 } });
      if (!rc.ok) return responder({ erro: 'Catálogo indisponível no momento.' }, 502);
      const cat = await rc.json();
      if (!freteConfigurado(cat.loja)) return responder({ erro: 'Frete ainda não configurado.' }, 503);
      const conf = conferirItens(corpo.itens, cat);
      if (conf.erro) return responder({ erro: conf.erro }, conf.status);
      const opcoes = await cotarFrete(env, cat.loja, cep, conf.linhas);
      if (!opcoes) return responder({ erro: 'Não foi possível calcular o frete agora.' }, 502);
      if (opcoes.length === 0) return responder({ erro: 'Nenhuma transportadora atende esse CEP.' }, 404);
      return responder({ opcoes });
    }

    if (!env.MP_ACCESS_TOKEN || !bases.length) return responder({ erro: 'Pagamento ainda não configurado.' }, 503);

    let pedido;
    try {
      pedido = await request.json();
    } catch {
      return responder({ erro: 'Pedido inválido.' }, 400);
    }
    if (pedido && pedido.armadilha) return responder({ erro: 'Pedido inválido.' }, 400);

    // Verificação anti-robô (Turnstile), quando a loja tiver ligado.
    if (env.TURNSTILE_SECRET) {
      const corpo = new FormData();
      corpo.append('secret', env.TURNSTILE_SECRET);
      corpo.append('response', String(pedido?.turnstile || ''));
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip) corpo.append('remoteip', ip);
      const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: corpo });
      const res = await v.json().catch(() => ({}));
      if (!res.success) return responder({ erro: 'Não foi possível confirmar a verificação. Tente de novo.' }, 403);
    }

    // Catálogo oficial: o mesmo arquivo que o site usa.
    const site = escolherBase(env, pedido?.site);
    const resp = await fetch(`${site}/produtos.json`, { cf: { cacheTtl: 60 } });
    if (!resp.ok) return responder({ erro: 'Catálogo indisponível no momento.' }, 502);
    const catalogo = await resp.json();
    const { loja } = catalogo;

    const texto = (v, max = 500) => String(v || '').trim().slice(0, max);
    const prefixoAnexo = `${url.origin}/anexo/`;
    const imagens = [];
    const itens = [];
    const conf = conferirItens(pedido.itens, catalogo);
    if (conf.erro) return responder({ erro: conf.erro }, conf.status);
    for (const { item, produto, unidades, precoUnitario } of conf.linhas) {
      const im = item.imagemPropria;
      if (im) {
        const link = texto(im.arquivo?.link, 300);
        imagens.push({
          santinho: produto.titulo,
          descricao: texto(im.descricao, 600),
          // Só aceita links do próprio armazenamento.
          arquivo: link.startsWith(prefixoAnexo) ? link : im.arquivo ? `enviar pelo WhatsApp (${texto(im.arquivo.nome, 120)})` : '',
        });
      }
      itens.push({
        id: produto.id,
        title: `${produto.titulo}${im ? ' (imagem própria)' : ''} — papel ${item.papel.toLowerCase()}`.slice(0, 250),
        description: produto.especificacoes || produto.titulo,
        picture_url: `${site}/${produto.imagem}`,
        category_id: 'others',
        quantity: unidades,
        unit_price: precoUnitario,
        currency_id: 'BRL',
      });
    }

    // Frete: cotado de novo aqui, pelo serviço escolhido; o valor que vem do navegador não conta.
    let frete = null;
    const freteAtivo = freteConfigurado(loja) && env.MELHOR_ENVIO_TOKEN && env.MELHOR_ENVIO_USER_AGENT;
    if (freteAtivo) {
      const cep = cepValido(pedido.frete?.cep);
      const servico = String(pedido.frete?.servicoId || '');
      if (!cep || !servico) return responder({ erro: 'Calcule e escolha o frete antes de pagar.' }, 400);
      const opcoes = await cotarFrete(env, loja, cep, conf.linhas);
      frete = opcoes?.find((o) => o.id === servico) || null;
      if (!frete) return responder({ erro: 'O frete escolhido não está mais disponível. Calcule de novo.' }, 400);
      frete.cep = cep;
      itens.push({
        id: 'frete',
        title: `Frete — ${frete.nome}${frete.empresa ? ` (${frete.empresa})` : ''}`.slice(0, 250),
        description: `Entrega para o CEP ${cep}`,
        category_id: 'others',
        quantity: 1,
        unit_price: frete.preco,
        currency_id: 'BRL',
      });
    }

    const c = pedido.cliente || {};
    if (!texto(c.nome) || !/^\S+@\S+\.\S+$/.test(texto(c.email))) {
      return responder({ erro: 'Confira o nome e o e-mail.' }, 400);
    }
    const referencia = /^OT-[0-9A-Z-]{4,20}$/.test(pedido.referencia) ? pedido.referencia : `OT-${Date.now()}`;

    const preferencia = {
      items: itens,
      payer: { name: texto(c.nome, 120), email: texto(c.email, 120) },
      external_reference: referencia,
      statement_descriptor: 'OTINTEIRO',
      back_urls: {
        success: `${site}/?pagamento=sucesso`,
        pending: `${site}/?pagamento=pendente`,
        failure: `${site}/?pagamento=falha`,
      },
      auto_return: 'approved',
      // Dados da encomenda ficam gravados no pagamento, visíveis pela API e pelo detalhe da venda.
      metadata: {
        referencia,
        whatsapp: texto(c.whatsapp, 40),
        data_sacramento: texto(c.dataSacramento, 20),
        personalizacao: texto(c.personalizacao, 1500),
        entrega: texto(c.entrega, 500),
        imagens_proprias: imagens,
        frete: frete ? { cep: frete.cep, servico: `${frete.nome} ${frete.empresa}`.trim(), preco: frete.preco, prazo_dias: frete.prazo } : null,
      },
      additional_info: `Pedido ${referencia}. Sacramento: ${texto(c.dataSacramento, 20)}. WhatsApp: ${texto(c.whatsapp, 40)}.`,
    };

    const mp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': referencia,
      },
      body: JSON.stringify(preferencia),
    });
    const dados = await mp.json().catch(() => ({}));
    if (!mp.ok || !dados.init_point) {
      console.log('Mercado Pago recusou a preferência', mp.status, JSON.stringify(dados));
      return responder({ erro: 'O Mercado Pago não respondeu como esperado.' }, 502);
    }

    // Com token de teste o Mercado Pago devolve também sandbox_init_point.
    const teste = String(env.MP_ACCESS_TOKEN).startsWith('TEST-');
    return responder({ link: teste && dados.sandbox_init_point ? dados.sandbox_init_point : dados.init_point, referencia });
  },

  // Uma vez por dia (ver [triggers] no wrangler.toml): apaga as imagens antigas dos clientes.
  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(limparAnexosAntigos(env));
  },
};
