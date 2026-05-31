import {
  CronCapability,
  HTTPClient,
  handler,
  Runner,
  consensusIdenticalAggregation,
  cre,
  type Runtime,
} from "@chainlink/cre-sdk";

import {
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  bytesToHex,
} from "viem";

export type Config = {
  rastroContractAddress: string;
  mapbiomasEmail: string;
  mapbiomasPassword: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
};

const MAPBIOMAS_GQL =
  "https://plataforma.alerta.mapbiomas.org/api/v2/graphql";

const RPC_URL =
  "https://ethereum-sepolia-rpc.publicnode.com";

const ETHEREUM_SEPOLIA_SELECTOR =
  BigInt("16015286601757825753");

const ABI = [
  {
    name: "listarTodos",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string[]" }],
  },
  {
    name: "statusCAR",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "codigoCAR", type: "string" }],
    outputs: [{ type: "uint8" }],
  },
] as const;

// action = 1: registra status cadastral do CAR
const REPORT_PARAMS = [
  { name: "action", type: "uint8" },
  { name: "codigoCAR", type: "string" },
  { name: "status", type: "uint8" },
] as const;

// action = 5: grava na blockchain o tx_hash da transacao de registro
// O contrato V2 precisa ter action == 5 no onReport.
const REPORT_TXHASH_PARAMS = [
  { name: "action", type: "uint8" },
  { name: "codigoCAR", type: "string" },
  { name: "txHashRegistro", type: "bytes32" },
] as const;

type Centroide = {
  lat: number | null;
  lon: number | null;
};

function encodeBody(data: object) {
  return new TextEncoder().encode(JSON.stringify(data));
}

function bodyToText(body: any) {
  if (typeof body === "string") return body;
  return new TextDecoder().decode(body);
}

function decodeBodySeguro(body: any, contexto: string) {
  if (!body) {
    throw new Error(`${contexto}: resposta HTTP sem body`);
  }

  const text = bodyToText(body);

  if (!text) {
    throw new Error(`${contexto}: resposta HTTP body vazio`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${contexto}: resposta nao era JSON: ${text.slice(0, 300)}`);
  }
}

function validarRpc(json: any, contexto: string) {
  if (!json) {
    throw new Error(`${contexto}: JSON vazio`);
  }

  if (json.error) {
    throw new Error(`${contexto}: erro RPC ${JSON.stringify(json.error)}`);
  }

  if (!json.result) {
    throw new Error(`${contexto}: RPC sem result`);
  }

  return json.result;
}

function safeStringify(value: any) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  try {
    const text = JSON.stringify(value, (_key, val) =>
      typeof val === "bigint" ? val.toString() : val
    );

    return text ?? String(value);
  } catch {
    return String(value);
  }
}

function txHashToString(txHash: any) {
  if (!txHash) return "";

  if (typeof txHash === "string") {
    return txHash;
  }

  try {
    return bytesToHex(txHash);
  } catch {
    return safeStringify(txHash);
  }
}

function txHashParaBytes32(txHash: string): `0x${string}` {
  const clean = String(txHash || "").trim();

  if (!/^0x[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`txHash invalido para bytes32: ${txHash}`);
  }

  return clean as `0x${string}`;
}

function hexToBase64(hex: string) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;

  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }

  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1];
    const b3 = bytes[i + 2];

    out += alphabet[b1 >> 2];
    out += alphabet[((b1 & 3) << 4) | ((b2 ?? 0) >> 4)];

    out += b2 === undefined
      ? "="
      : alphabet[((b2 & 15) << 2) | ((b3 ?? 0) >> 6)];

    out += b3 === undefined
      ? "="
      : alphabet[b3 & 63];
  }

  return out;
}

function normalizarCAR(valor: string) {
  return (valor || "").trim().replace(/,/g, "");
}

function statusTexto(status: number | null) {
  if (status === 0) return "PENDENTE";
  if (status === 1) return "ATIVO";
  if (status === 2) return "INATIVO";
  return "DESCONHECIDO";
}

function centroideBoundingBox(boundingBox: any): Centroide {
  if (Array.isArray(boundingBox) && boundingBox.length >= 4) {
    const west = Number(boundingBox[0]);
    const south = Number(boundingBox[1]);
    const east = Number(boundingBox[2]);
    const north = Number(boundingBox[3]);

    if ([west, south, east, north].every(Number.isFinite)) {
      return {
        lat: (south + north) / 2,
        lon: (west + east) / 2,
      };
    }
  }

  if (boundingBox && typeof boundingBox === "object") {
    const west = Number(boundingBox.west ?? boundingBox.minLon ?? boundingBox.xmin);
    const south = Number(boundingBox.south ?? boundingBox.minLat ?? boundingBox.ymin);
    const east = Number(boundingBox.east ?? boundingBox.maxLon ?? boundingBox.xmax);
    const north = Number(boundingBox.north ?? boundingBox.maxLat ?? boundingBox.ymax);

    if ([west, south, east, north].every(Number.isFinite)) {
      return {
        lat: (south + north) / 2,
        lon: (west + east) / 2,
      };
    }
  }

  return { lat: null, lon: null };
}

function wktParaGeoJSON(wkt: any): any | null {
  if (!wkt || typeof wkt !== "string") return null;

  let texto = wkt.trim();
  const idx = texto.indexOf(";");

  if (texto.toUpperCase().startsWith("SRID=") && idx >= 0) {
    texto = texto.slice(idx + 1).trim();
  }

  const up = texto.toUpperCase();
  const ehMulti = up.startsWith("MULTIPOLYGON");
  const ehPoly = up.startsWith("POLYGON");

  if (!ehMulti && !ehPoly) return null;

  const inicio = texto.indexOf("(");
  const fim = texto.lastIndexOf(")");

  if (inicio < 0 || fim < 0) return null;

  const corpo = texto.slice(inicio, fim + 1);

  function parseAnel(anelTexto: string): number[][] {
    return anelTexto
      .split(",")
      .map((par) => par.trim().split(/\s+/).map(Number))
      .filter((c) => c.length >= 2 && c.every(Number.isFinite))
      .map((c) => [c[0], c[1]]);
  }

  try {
    if (ehMulti) {
      const m = corpo.replace(/^\(/, "").replace(/\)$/, "");
      const fimPrimeiro = m.indexOf(")),");
      const primeiro = fimPrimeiro >= 0 ? m.slice(0, fimPrimeiro + 2) : m;

      const p = primeiro.replace(/^\(/, "").replace(/\)$/, "");

      const aneis = p.split(/\)\s*,\s*\(/).map((a) =>
        a.replace(/^\(/, "").replace(/\)$/, "")
      );

      const coords = aneis.map(parseAnel);

      return {
        type: "Polygon",
        coordinates: coords,
      };
    }

    const p = corpo.replace(/^\(/, "").replace(/\)$/, "");

    const aneis = p.split(/\)\s*,\s*\(/).map((a) =>
      a.replace(/^\(/, "").replace(/\)$/, "")
    );

    const coords = aneis.map(parseAnel);

    return {
      type: "Polygon",
      coordinates: coords,
    };
  } catch {
    return null;
  }
}

function lerStatusCAR(
  httpClient: HTTPClient,
  nodeRuntime: any,
  address: `0x${string}`,
  codigoCAR: string,
  id: number
): number | null {
  try {
    const data =
      encodeFunctionData({
        abi: ABI,
        functionName: "statusCAR",
        args: [codigoCAR],
      });

    const resp =
      httpClient.sendRequest(
        nodeRuntime,
        {
          url: RPC_URL,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: encodeBody({
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: address, data }, "latest"],
            id,
          }),
        } as any
      ).result();

    const json =
      decodeBodySeguro(resp?.body, `RPC statusCAR ${codigoCAR}`);

    if (json?.error || !json?.result) {
      return null;
    }

    const decoded =
      decodeFunctionResult({
        abi: ABI,
        functionName: "statusCAR",
        data: json.result,
      }) as unknown as number;

    return Number(decoded);
  } catch {
    return null;
  }
}

function salvarTerritorioSupabase(
  httpClient: HTTPClient,
  nodeRuntime: any,
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  payload: object
) {
  const baseUrl = supabaseUrl.replace(/\/+$/, "");

  if (!baseUrl) {
    throw new Error("Supabase URL vazia");
  }

  if (!supabaseServiceRoleKey) {
    throw new Error("Supabase service role key vazia");
  }

  const resp =
    httpClient.sendRequest(
      nodeRuntime,
      {
        url: `${baseUrl}/rest/v1/rastro_territorios?on_conflict=codigo_car`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": supabaseServiceRoleKey,
          "Authorization": `Bearer ${supabaseServiceRoleKey}`,
          "Prefer": "resolution=merge-duplicates,return=representation",
        },
        body: encodeBody(payload),
      } as any
    ).result();

  const statusCode =
    Number((resp as any)?.statusCode ?? (resp as any)?.status ?? 200);

  const json =
    decodeBodySeguro(resp?.body, "Supabase rastro_territorios");

  if (statusCode >= 400 || json?.message || json?.error) {
    throw new Error(`Supabase erro: ${safeStringify(json)}`);
  }

  return json;
}

function escreverReportOnchain(
  runtime: Runtime<Config>,
  reportFn: any,
  evmClient: any,
  reportHex: string,
  contexto: string
) {
  runtime.log(`${contexto} report hex: ${reportHex}`);

  const reportResponse =
    reportFn.call(runtime, {
      encodedPayload: hexToBase64(reportHex),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    }).result();

  runtime.log(`${contexto} reportResponse: ${safeStringify(reportResponse)}`);

  const writeResp =
    evmClient.writeReport(runtime as any, {
      receiver: runtime.config.rastroContractAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: "1000000",
      },
    }).result();

  const txHash =
    txHashToString((writeResp as any)?.txHash);

  runtime.log(`${contexto} writeResp completo: ${safeStringify(writeResp)}`);
  runtime.log(`${contexto} txHash: ${txHash || "sem txHash"}`);
  runtime.log(`${contexto} txStatus: ${safeStringify((writeResp as any)?.txStatus)}`);
  runtime.log(
    `${contexto} receiverContractExecutionStatus: ${safeStringify(
      (writeResp as any)?.receiverContractExecutionStatus
    )}`
  );
  runtime.log(`${contexto} errorMessage: ${safeStringify((writeResp as any)?.errorMessage)}`);

  return txHash;
}

export const onFazendaCadastrada = (
  runtime: Runtime<Config>
): string => {
  runtime.log("PATROL REGISTRO - VERIFICACAO TERRITORIAL V2 TXHASH ONCHAIN");

  const httpClient = new HTTPClient();

  const result =
    runtime.runInNodeMode(
      (nodeRuntime: any) => {
        const address =
          runtime.config.rastroContractAddress as `0x${string}`;

        const supabaseUrl =
          String(runtime.config.supabaseUrl || "").trim();

        const supabaseServiceRoleKey =
          String(runtime.config.supabaseServiceRoleKey || "").trim();

        runtime.log(`Contrato: ${address}`);

        const listarData =
          encodeFunctionData({
            abi: ABI,
            functionName: "listarTodos",
          });

        const rpcResp =
          httpClient.sendRequest(
            nodeRuntime,
            {
              url: RPC_URL,
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: encodeBody({
                jsonrpc: "2.0",
                method: "eth_call",
                params: [{ to: address, data: listarData }, "latest"],
                id: 1,
              }),
            } as any
          ).result();

        const rpcJson =
          decodeBodySeguro(
            rpcResp?.body,
            "RPC listarTodos"
          );

        const listarResult =
          validarRpc(
            rpcJson,
            "RPC listarTodos"
          );

        const lista =
          decodeFunctionResult({
            abi: ABI,
            functionName: "listarTodos",
            data: listarResult,
          }) as unknown as string[];

        runtime.log(`Total fazendas: ${lista.length}`);

        if (lista.length === 0) {
          return "SEM_FAZENDAS";
        }

        let codigoPendente = "";

        for (let i = 0; i < lista.length; i++) {
          const codigoCAR = normalizarCAR(lista[i] || "");

          if (!codigoCAR) {
            runtime.log(`[${i + 1}/${lista.length}] CAR vazio - pula`);
            continue;
          }

          const statusAtual =
            lerStatusCAR(
              httpClient,
              nodeRuntime,
              address,
              codigoCAR,
              100 + i
            );

          runtime.log(
            `[${i + 1}/${lista.length}] ${codigoCAR} | status on-chain: ${statusTexto(statusAtual)}`
          );

          if (statusAtual === 0) {
            codigoPendente = codigoCAR;
            break;
          }

          if (statusAtual === 1 || statusAtual === 2) {
            runtime.log("CAR ja verificado on-chain - pula");
            continue;
          }

          runtime.log("Nao foi possivel ler status do CAR - pula por seguranca");
        }

        if (!codigoPendente) {
          return "SEM_PENDENTES";
        }

        const authResp =
          httpClient.sendRequest(
            nodeRuntime,
            {
              url: MAPBIOMAS_GQL,
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: encodeBody({
                query: `
mutation {
  signIn(
    email: "${runtime.config.mapbiomasEmail}",
    password: "${runtime.config.mapbiomasPassword}"
  ) { token }
}
`,
              }),
            } as any
          ).result();

        const authJson =
          decodeBodySeguro(
            authResp?.body,
            "MapBiomas login"
          );

        if (authJson?.errors) {
          throw new Error(
            `MapBiomas login GraphQL errors: ${JSON.stringify(authJson.errors)}`
          );
        }

        const token =
          authJson?.data?.signIn?.token;

        if (!token) {
          runtime.log("ERRO LOGIN MAPBIOMAS");
          return "ERRO_LOGIN";
        }

        runtime.log("MapBiomas autenticado");
        runtime.log(`Processando pendente: ${codigoPendente}`);

        const propertyResp =
          httpClient.sendRequest(
            nodeRuntime,
            {
              url: MAPBIOMAS_GQL,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
              },
              body: encodeBody({
                query: `
query ruralProperty($carCode: String!) {
  ruralProperty(carCode: $carCode) {
    propertyCode
    areaHa
    state
    stateAcronym
    version
    boundingBox
    geomRuralProperty
  }
}
`,
                variables: { carCode: codigoPendente },
              }),
            } as any
          ).result();

        const propertyJson =
          decodeBodySeguro(
            propertyResp?.body,
            `MapBiomas ruralProperty ${codigoPendente}`
          );

        if (propertyJson?.errors) {
          runtime.log(
            `MapBiomas ruralProperty errors: ${JSON.stringify(propertyJson.errors)}`
          );
        }

        const property =
          propertyJson?.data?.ruralProperty;

        if (!property || !property.propertyCode) {
          runtime.log("CAR INVALIDO");

          salvarTerritorioSupabase(
            httpClient,
            nodeRuntime,
            supabaseUrl,
            supabaseServiceRoleKey,
            {
              codigo_car: codigoPendente,
              status: "INATIVO",
              payload: {
                tipo: "territorial",
                codigoCAR: codigoPendente,
                motivo: "CAR nao encontrado no MapBiomas",
                mapbiomasResposta: propertyJson,
              },
              updated_at: new Date().toISOString(),
            }
          );

          runtime.log(`Supabase salvo como INATIVO: ${codigoPendente}`);
          runtime.log("Montando report status=INATIVO");

          const reportHex =
            encodeAbiParameters(
              REPORT_PARAMS,
              [1, codigoPendente, 2]
            );

          return `REPORT|${reportHex}|${codigoPendente}`;
        }

        runtime.log("CAR VALIDO");
        runtime.log(`Area: ${property.areaHa}ha | Estado: ${property.stateAcronym}`);
        runtime.log(`BoundingBox: ${JSON.stringify(property.boundingBox)}`);

        const geomWkt =
          property.geomRuralProperty || null;

        const geomGeoJSON =
          wktParaGeoJSON(geomWkt);

        runtime.log(
          geomWkt
            ? `Geometria do CAR capturada (len=${String(geomWkt).length})`
            : "Geometria do CAR nao retornada"
        );

        const centroide =
          centroideBoundingBox(property.boundingBox);

        salvarTerritorioSupabase(
          httpClient,
          nodeRuntime,
          supabaseUrl,
          supabaseServiceRoleKey,
          {
            codigo_car: codigoPendente,
            status: "ATIVO",
            property_code: property.propertyCode,
            area_ha: property.areaHa,
            estado: property.state,
            state_acronym: property.stateAcronym,
            bounding_box: property.boundingBox,
            geometry_wkt: geomWkt,
            geojson: geomGeoJSON,
            centroid_lat: centroide.lat,
            centroid_lon: centroide.lon,
            payload: {
              tipo: "territorial",
              codigoCAR: codigoPendente,
              propertyCode: property.propertyCode,
              areaHa: property.areaHa,
              estado: property.state,
              stateAcronym: property.stateAcronym,
              versao: property.version,
              boundingBox: property.boundingBox,
              geometryWkt: geomWkt,
              dataSource: "MapBiomas Alerta v2",
            },
            updated_at: new Date().toISOString(),
          }
        );

        runtime.log(`Supabase salvo como ATIVO: ${codigoPendente}`);
        runtime.log("Montando report status=ATIVO");

        const reportHex =
          encodeAbiParameters(
            REPORT_PARAMS,
            [1, codigoPendente, 1]
          );

        return `REPORT|${reportHex}|${codigoPendente}`;
      },

      consensusIdenticalAggregation<string>()
    )().result();

  if (!result || !result.startsWith("REPORT|")) {
    runtime.log(`Sem escrita on-chain: ${result}`);
    return result || "SEM_REPORT";
  }

  const partes =
    result.split("|");

  const reportData =
    partes[1];

  const codigoCarOut =
    partes[2];

  if (!reportData || !reportData.startsWith("0x")) {
    runtime.log(`Report invalido: ${reportData}`);
    return "REPORT_INVALIDO";
  }

  if (!codigoCarOut) {
    runtime.log("codigoCarOut vazio");
    return "CAR_OUT_VAZIO";
  }

  runtime.log(`Report territorial hex: ${reportData}`);
  runtime.log(`CAR do report territorial: ${codigoCarOut}`);

  const reportFn =
    (runtime as any).report;

  runtime.log(`typeof runtime.report = ${typeof reportFn}`);

  if (typeof reportFn !== "function") {
    throw new Error("runtime.report nao existe neste runtime do CRE");
  }

  const evmClient =
    new cre.capabilities.EVMClient(
      ETHEREUM_SEPOLIA_SELECTOR
    );

  runtime.log(`typeof evmClient.writeReport = ${typeof evmClient.writeReport}`);

  const txHashRegistro =
    escreverReportOnchain(
      runtime,
      reportFn,
      evmClient,
      reportData,
      "REGISTRO STATUS"
    );

  if (!txHashRegistro) {
    runtime.log("Registro enviado, mas sem txHash retornado. Nao sera possivel salvar tx_hash on-chain.");
    return "REGISTRO_FINALIZADO_SEM_TXHASH";
  }

  runtime.log(`tx_hash original do registro recebido: ${txHashRegistro}`);
  runtime.log("Preparando segundo report para gravar o tx_hash do registro dentro do contrato V2");

  const txHashBytes32 =
    txHashParaBytes32(txHashRegistro);

  const reportTxHashHex =
    encodeAbiParameters(
      REPORT_TXHASH_PARAMS,
      [5, codigoCarOut, txHashBytes32]
    );

  const txHashDaGravacao =
    escreverReportOnchain(
      runtime,
      reportFn,
      evmClient,
      reportTxHashHex,
      "REGISTRO TXHASH ONCHAIN"
    );

  runtime.log(`tx_hash do registro salvo on-chain como evidencia: ${txHashRegistro}`);
  runtime.log(`tx_hash da transacao que gravou essa evidencia: ${txHashDaGravacao || "sem txHash"}`);

  return "REGISTRO_FINALIZADO_TXHASH_ONCHAIN";
};

export const initWorkflow = (
  config: Config
) => {
  const cron =
    new CronCapability();

  return [
    handler(
      cron.trigger({
        schedule: "0 * * * *",
      }) as any,
      onFazendaCadastrada
    ),
  ];
};

export async function main() {
  const runner =
    await Runner.newRunner<Config>();

  await runner.run(initWorkflow);
}
