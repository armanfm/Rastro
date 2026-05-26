import {
  CronCapability,
  HTTPClient,
  handler,
  Runner,
  consensusIdenticalAggregation,
  type Runtime,
} from "@chainlink/cre-sdk";

import { encodeFunctionData, decodeFunctionResult } from "viem";

export type Config = {
  rastroContractAddress: string;
  geminiKey: string;
  pinataJwt: string;
  mapbiomasEmail: string;
  mapbiomasPassword: string;
};

type Alert = {
  id: string;
  afterImageDate?: string;
  geomAreaHa?: number;
};

type Embargo = {
  seqTad: string;
  areaHa: number;
  dataEmissao: string;
  situacao: string;
};

type Resultado = {
  score: number;
  risco: number;
  justificativa: string;
  ipfsCID: string;
};

const MAPBIOMAS_GQL = "https://plataforma.alerta.mapbiomas.org/api/v2/graphql";
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const IBAMA_URL = "https://pamgia.ibama.gov.br/server/rest/services/01_Publicacoes_Bases/adm_embargos_ibama_a/FeatureServer/0/query";
const SICAR_WFS = "https://geoserver.car.gov.br/geoserver/sicar/ows";
const SETE_DIAS_S = 7 * 24 * 60 * 60;

const ABI = [
  {
    name: "totalFazendas",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }]
  },
  {
    name: "listarTodos",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string[]" }]
  },
  {
    name: "getFazenda",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "codigoCAR", type: "string" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "codigoCAR",    type: "string"  }, // 0
        { name: "dono",         type: "address" }, // 1
        { name: "score",        type: "uint8"   }, // 2
        { name: "risco",        type: "uint8"   }, // 3
        { name: "atualizadoEm", type: "uint256" }, // 4
        { name: "cid",          type: "string"  }, // 5
        { name: "existe",       type: "bool"    }, // 6
        { name: "tokenId",      type: "uint256" }  // 7
      ]
    }]
  },
  {
    name: "registrarVerificacao",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "codigoCAR", type: "string" },
      { name: "score",     type: "uint8"  },
      { name: "risco",     type: "uint8"  },
      { name: "cid",       type: "string" }
    ],
    outputs: []
  },
  {
    name: "invalidarCAR",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "codigoCAR", type: "string" }],
    outputs: []
  }
] as const;

function rpcCall(runtime: Runtime<Config>, httpClient: HTTPClient, payload: object): any {
  return runtime.runInNodeMode((nodeRuntime) => {
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    const resp = httpClient.sendRequest(nodeRuntime, {
      url: RPC_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: enc.encode(JSON.stringify(payload))
    }).result();
    return JSON.parse(dec.decode(resp.body));
  }, consensusIdenticalAggregation<any>())().result();
}

function buscarPoligonoSICAR(
  httpClient: HTTPClient,
  nodeRuntime: any,
  codigoCAR: string
): number[][][] | null {
  const dec = new TextDecoder();
  try {
    const params = new URLSearchParams({
      service: "WFS",
      version: "1.0.0",
      request: "GetFeature",
      typeName: "sicar:car_imovel",
      CQL_FILTER: `cod_imovel='${codigoCAR}'`,
      outputFormat: "application/json",
      srsName: "EPSG:4326"
    });
    const resp = httpClient.sendRequest(nodeRuntime, {
      url: `${SICAR_WFS}?${params.toString()}`,
      method: "GET",
      headers: {}
    }).result();
    const geojson = JSON.parse(dec.decode(resp.body)) as any;
    const coords = geojson?.features?.[0]?.geometry?.coordinates;
    if (coords && coords.length > 0) {
      nodeRuntime.log(`   SICAR: poligono com ${coords[0].length} vertices`);
      return coords;
    }
    return null;
  } catch {
    nodeRuntime.log(`   SICAR: falha ao buscar poligono`);
    return null;
  }
}

function consultarIBAMA(
  httpClient: HTTPClient,
  nodeRuntime: any,
  poligono: number[][][] | null,
  lat: number,
  lon: number
): Embargo[] {
  const dec = new TextDecoder();
  try {
    let geometry: string;
    let geometryType: string;

    if (poligono) {
      geometry = encodeURIComponent(JSON.stringify({
        rings: poligono.map(anel => anel.map(([x, y]) => [x, y])),
        spatialReference: { wkid: 4326 }
      }));
      geometryType = "esriGeometryPolygon";
      nodeRuntime.log(`   IBAMA: consultando por poligono completo`);
    } else {
      geometry = encodeURIComponent(JSON.stringify({ x: lon, y: lat }));
      geometryType = "esriGeometryPoint";
      nodeRuntime.log(`   IBAMA: consultando por centroide (fallback)`);
    }

    const ibamaResp = httpClient.sendRequest(nodeRuntime, {
      url: `${IBAMA_URL}?geometry=${geometry}&geometryType=${geometryType}&spatialRel=esriSpatialRelIntersects&inSR=4326&outFields=seq_tad,des_area_embargada,dat_tad,des_situacao_tad&f=json&resultRecordCount=20`,
      method: "GET",
      headers: {}
    }).result();

    const ibamaData = JSON.parse(dec.decode(ibamaResp.body)) as any;
    return (ibamaData?.features || []).map((f: any) => ({
      seqTad: f.attributes?.seq_tad,
      areaHa: f.attributes?.des_area_embargada,
      dataEmissao: f.attributes?.dat_tad,
      situacao: f.attributes?.des_situacao_tad
    }));
  } catch {
    nodeRuntime.log(`   IBAMA: erro na consulta`);
    return [];
  }
}

function analisarCAR(
  runtime: Runtime<Config>,
  httpClient: HTTPClient,
  codigoCAR: string
): Resultado {
  return runtime.runInNodeMode((nodeRuntime) => {
    const dec = new TextDecoder();
    const enc = new TextEncoder();

    // Login MapBiomas
    const authResp = httpClient.sendRequest(nodeRuntime, {
      url: MAPBIOMAS_GQL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: enc.encode(JSON.stringify({
        query: `mutation { signIn(email: "${runtime.config.mapbiomasEmail}", password: "${runtime.config.mapbiomasPassword}") { token } }`
      }))
    }).result();
    const token: string = (JSON.parse(dec.decode(authResp.body)) as any)?.data?.signIn?.token;
    if (!token) throw new Error("Falha autenticacao MapBiomas");

    // Propriedade + centroide
    const propertyResp = httpClient.sendRequest(nodeRuntime, {
      url: MAPBIOMAS_GQL,
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: enc.encode(JSON.stringify({
        query: `{
          property(carCode: "${codigoCAR}") {
            id name state area
            centroid { lat lon }
          }
        }`
      }))
    }).result();
    const propertyData = (JSON.parse(dec.decode(propertyResp.body)) as any)?.data?.property;

    // CAR nao existe no SICAR — retorna sem chamar IPFS
    if (!propertyData) {
      nodeRuntime.log(`   CAR nao encontrado no SICAR`);
      return {
        score: 100,
        risco: 2,
        justificativa: "CAR invalido - nao encontrado no SICAR",
        ipfsCID: ""
      };
    }

    const nomeOficial: string = propertyData.name || "";
    const lat: number = propertyData.centroid?.lat ?? 0;
    const lon: number = propertyData.centroid?.lon ?? 0;
    nodeRuntime.log(`   MapBiomas: ${nomeOficial} | ${propertyData.state} | ${propertyData.area}ha | ${lat},${lon}`);

    // Alertas desmatamento
    const alertResp = httpClient.sendRequest(nodeRuntime, {
      url: MAPBIOMAS_GQL,
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: enc.encode(JSON.stringify({
        query: `{ validatedAlerts(carCode: "${codigoCAR}", page: 1, perPage: 20) { id afterImageDate geomAreaHa } }`
      }))
    }).result();
    const alertas: Alert[] = (JSON.parse(dec.decode(alertResp.body)) as any)?.data?.validatedAlerts ?? [];
    const areaTotal = alertas.reduce((s: number, a: Alert) => s + (a.geomAreaHa || 0), 0);
    const seisMesesAtras = new Date();
    seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);
    const alertasRecentes = alertas.filter((a: Alert) =>
      a.afterImageDate && new Date(a.afterImageDate) > seisMesesAtras
    ).length;
    nodeRuntime.log(`   Alertas: ${alertas.length} | ${areaTotal}ha | ${alertasRecentes} recentes`);

    // Poligono SICAR + IBAMA espacial
    const poligono = buscarPoligonoSICAR(httpClient, nodeRuntime, codigoCAR);
    const embargos = consultarIBAMA(httpClient, nodeRuntime, poligono, lat, lon);
    const embargoAtivo = embargos.filter((e: Embargo) => e.situacao?.includes("ATIVO")).length;
    nodeRuntime.log(`   IBAMA: ${embargos.length} embargo(s) | ${embargoAtivo} ativo(s)`);

    // Gemini
    const prompt = `Retorne APENAS JSON valido: {"score":0-100,"risco":0,"justificativa":"max 80 chars"} onde risco: 0=BAIXO 1=MEDIO 2=ALTO
CAR: ${codigoCAR}
Propriedade: ${nomeOficial} | ${propertyData.state} | ${propertyData.area}ha
MapBiomas: ${alertas.length} alertas, ${areaTotal}ha, ${alertasRecentes} recentes (ultimos 6 meses)
IBAMA (interseccao ${poligono ? "poligono completo" : "centroide"}): ${embargos.length} embargos, ${embargoAtivo} ativos
Avalie risco EUDR`;

    const geminiResp = httpClient.sendRequest(nodeRuntime, {
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${runtime.config.geminiKey}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: enc.encode(JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
      }))
    }).result();

    const texto = (JSON.parse(dec.decode(geminiResp.body)) as any)?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    let score: number, risco: number, justificativa: string;
    try {
      const analise = JSON.parse(texto.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
      score = Math.min(100, Math.max(0, analise.score || 50));
      risco = Math.min(2, Math.max(0, analise.risco ?? 1));
      justificativa = (analise.justificativa || "Analise automatica").substring(0, 80);
    } catch {
      score = 50; risco = 1; justificativa = "Erro na analise Gemini";
    }
    nodeRuntime.log(`   Gemini: score=${score} risco=${risco} -> ${justificativa}`);

    // IPFS
    const pinataResp = httpClient.sendRequest(nodeRuntime, {
      url: "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${runtime.config.pinataJwt}` },
      body: enc.encode(JSON.stringify({
        pinataContent: {
          codigoCAR, nomeOficial,
          estado: propertyData.state,
          areaHa: propertyData.area,
          coordenadas: { lat, lon },
          poligonoObtido: !!poligono,
          status: "APROVADO",
          mapbiomas: { alertas, areaTotal, alertasRecentes },
          ibama: { embargos, embargoAtivo, metodo: poligono ? "poligono_completo" : "centroide" },
          score, risco, justificativa,
          data: new Date().toISOString()
        },
        pinataMetadata: { name: `RASTRO-${codigoCAR}-${Date.now()}` }
      }))
    }).result();

    const ipfsCID = (JSON.parse(dec.decode(pinataResp.body)) as any).IpfsHash;
    if (!ipfsCID) throw new Error("Falha IPFS");
    return { score, risco, justificativa, ipfsCID };

  }, consensusIdenticalAggregation<Resultado>())().result();
}

export const onCronTrigger = async (runtime: Runtime<Config>): Promise<string> => {
  runtime.log("RASTRO - Verificacao EUDR");

  const address = runtime.config.rastroContractAddress as `0x${string}`;
  const httpClient = new HTTPClient();
  const agora = BigInt(Math.floor(Date.now() / 1000));

  // Total fazendas
  const totalData = encodeFunctionData({ abi: ABI, functionName: "totalFazendas" });
  const totalResp = rpcCall(runtime, httpClient, {
    jsonrpc: "2.0", method: "eth_call",
    params: [{ to: address, data: totalData }, "latest"], id: 1
  });
  const total = decodeFunctionResult({
    abi: ABI, functionName: "totalFazendas", data: totalResp.result
  }) as unknown as bigint;
  runtime.log(`Total fazendas: ${total}`);

  if (total === 0n) { runtime.log("Nenhuma fazenda cadastrada"); return "SEM_FAZENDAS"; }

  // Lista todos os CARs
  const listarData = encodeFunctionData({ abi: ABI, functionName: "listarTodos" });
  const listarResp = rpcCall(runtime, httpClient, {
    jsonrpc: "2.0", method: "eth_call",
    params: [{ to: address, data: listarData }, "latest"], id: 2
  });
  const lista = decodeFunctionResult({
    abi: ABI, functionName: "listarTodos", data: listarResp.result
  }) as unknown as string[];

  for (let i = 0; i < lista.length; i++) {
    const car = lista[i].trim().replace(/,/g, "");
    runtime.log(`[${i + 1}/${total}] ${car}`);

    if (!/^[A-Z]{2}-\d{7}/i.test(car)) { runtime.log("   Formato invalido"); continue; }

    const fazendaData = encodeFunctionData({ abi: ABI, functionName: "getFazenda", args: [car] });
    const fazendaResp = rpcCall(runtime, httpClient, {
      jsonrpc: "2.0", method: "eth_call",
      params: [{ to: address, data: fazendaData }, "latest"], id: 3 + i
    });
    const fazenda = decodeFunctionResult({
      abi: ABI, functionName: "getFazenda", data: fazendaResp.result
    }) as unknown as any;

    const scoreAtual: number   = Number(fazenda?.score ?? fazenda?.[2] ?? 0);
    const riscoAtual: number   = Number(fazenda?.risco ?? fazenda?.[3] ?? 3);
    const atualizadoEm: bigint = BigInt(fazenda?.atualizadoEm ?? fazenda?.[4] ?? 0);
    const cidAtual: string     = (fazenda?.cid ?? fazenda?.[5] ?? "") as string;

    const isPrimeira = cidAtual === "" || riscoAtual === 3;
    const passouSeteDias = (agora - atualizadoEm) > BigInt(SETE_DIAS_S);

    if (!isPrimeira && !passouSeteDias) {
      const dias = Number(BigInt(SETE_DIAS_S) - (agora - atualizadoEm)) / 86400;
      runtime.log(`   Verificacao recente - proxima em ~${dias.toFixed(1)} dia(s)`);
      continue;
    }

    runtime.log(isPrimeira ? "   Primeira analise" : "   7 dias - reanalisando");

    const resultado = analisarCAR(runtime, httpClient, car);

    // CAR invalido no SICAR — queima o NFT
    if (resultado.ipfsCID === "") {
      runtime.log(`   CAR invalido - queimando NFT`);
      const invalidarData = encodeFunctionData({
        abi: ABI,
        functionName: "invalidarCAR",
        args: [car]
      });
      runtime.log(`   invalidarCAR("${car}")`);
      continue;
    }

    runtime.log(`   Score: ${resultado.score} | Risco: ${resultado.risco} | ${resultado.justificativa}`);
    runtime.log(`   IPFS: ${resultado.ipfsCID}`);

    // Reanalise: so registra onchain se mudou
    if (!isPrimeira && resultado.score === scoreAtual && resultado.risco === riscoAtual) {
      runtime.log(`   Sem mudanca - nao registra onchain`);
      continue;
    }

    const registrarData = encodeFunctionData({
      abi: ABI,
      functionName: "registrarVerificacao",
      args: [car, resultado.score, resultado.risco, resultado.ipfsCID]
    });

    runtime.log(`   registrarVerificacao("${car}", ${resultado.score}, ${resultado.risco}, "${resultado.ipfsCID}")`);
  }

  return "OK";
};

export const initWorkflow = () => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: "0 0 * * 1" }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}