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
  pinataJwt: string;
};

const MAPBIOMAS_GQL =
  "https://plataforma.alerta.mapbiomas.org/api/v2/graphql";

const RPC_URL =
  "https://ethereum-sepolia-rpc.publicnode.com";

const PINATA_URL =
  "https://api.pinata.cloud/pinning/pinJSONToIPFS";

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
    name: "cidTerritorial",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "codigoCAR", type: "string" }],
    outputs: [{ type: "string" }],
  },
] as const;

const REPORT_PARAMS = [
  { name: "action", type: "uint8" },
  { name: "codigoCAR", type: "string" },
  { name: "status", type: "uint8" },
  { name: "cid", type: "string" },
] as const;

function encodeBody(data: object) {
  return new TextEncoder().encode(JSON.stringify(data));
}

function decodeBodySeguro(body: any, contexto: string) {
  if (!body) {
    throw new Error(`${contexto}: resposta HTTP sem body`);
  }

  const text = new TextDecoder().decode(body);

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

function lerCidTerritorial(
  httpClient: HTTPClient,
  nodeRuntime: any,
  address: `0x${string}`,
  codigoCAR: string,
  id: number
): string {
  try {
    const data =
      encodeFunctionData({
        abi: ABI,
        functionName: "cidTerritorial",
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
        }
      ).result();

    const json =
      decodeBodySeguro(resp?.body, `RPC cidTerritorial ${codigoCAR}`);

    if (json?.error || !json?.result) {
      return "";
    }

    return decodeFunctionResult({
      abi: ABI,
      functionName: "cidTerritorial",
      data: json.result,
    }) as unknown as string;
  } catch {
    return "";
  }
}

export const onFazendaCadastrada = (
  runtime: Runtime<Config>
): string => {
  runtime.log("PATROL REGISTRO - VERIFICACAO TERRITORIAL");

  const httpClient = new HTTPClient();

  const reportData =
    runtime.runInNodeMode(
      (nodeRuntime: any) => {
        const address =
          runtime.config.rastroContractAddress as `0x${string}`;

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
            }
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
            }
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

        for (let i = 0; i < lista.length; i++) {
          const codigoCAR =
            lista[i]?.trim().replace(/,/g, "") || "";

          runtime.log(`[${i + 1}/${lista.length}] ${codigoCAR}`);

          if (!codigoCAR) {
            runtime.log("CAR vazio");
            continue;
          }

          const cidAtual =
            lerCidTerritorial(
              httpClient,
              nodeRuntime,
              address,
              codigoCAR,
              10 + i
            );

          if (cidAtual) {
            runtime.log(`Ja tem CID territorial: ${cidAtual} - pula`);
            continue;
          }

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
  }
}
`,
                  variables: { carCode: codigoCAR },
                }),
              }
            ).result();

          const propertyJson =
            decodeBodySeguro(
              propertyResp?.body,
              `MapBiomas ruralProperty ${codigoCAR}`
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
            runtime.log("Montando report territorial invalido");

            return encodeAbiParameters(
              REPORT_PARAMS,
              [1, codigoCAR, 2, ""]
            );
          }

          runtime.log("CAR VALIDO");
          runtime.log(`Area: ${property.areaHa}ha | Estado: ${property.stateAcronym}`);
          runtime.log(`BoundingBox: ${JSON.stringify(property.boundingBox)}`);

          const pinataResp =
            httpClient.sendRequest(
              nodeRuntime,
              {
                url: PINATA_URL,
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${runtime.config.pinataJwt}`,
                },
                body: encodeBody({
                  pinataContent: {
                    tipo: "territorial",
                    codigoCAR,
                    propertyCode: property.propertyCode,
                    areaHa: property.areaHa,
                    estado: property.state,
                    stateAcronym: property.stateAcronym,
                    versao: property.version,
                    boundingBox: property.boundingBox,
                  },
                  pinataMetadata: {
                    name: `RASTRO-TERRITORIAL-${codigoCAR}`,
                  },
                }),
              }
            ).result();

          const pinataJson =
            decodeBodySeguro(
              pinataResp?.body,
              `Pinata ${codigoCAR}`
            );

          const cidTerritorial =
            pinataJson?.IpfsHash;

          if (!cidTerritorial) {
            runtime.log(
              `ERRO IPFS - resposta: ${JSON.stringify(pinataJson)}`
            );

            continue;
          }

          runtime.log(`CID Territorial: ${cidTerritorial}`);
          runtime.log("Montando report territorial valido");

          return encodeAbiParameters(
            REPORT_PARAMS,
            [1, codigoCAR, 1, cidTerritorial]
          );
        }

        return "NADA_PARA_REGISTRAR";
      },

      consensusIdenticalAggregation<string>()
    )().result();

  if (!reportData || !reportData.startsWith("0x")) {
    runtime.log(`Sem escrita on-chain: ${reportData}`);
    return reportData || "SEM_REPORT";
  }

  runtime.log(`Report territorial hex: ${reportData}`);

  const reportFn = (runtime as any).report;

  runtime.log(`typeof runtime.report = ${typeof reportFn}`);

  if (typeof reportFn !== "function") {
    throw new Error("runtime.report nao existe neste runtime do CRE");
  }

  const reportResponse =
    reportFn.call(runtime, {
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    }).result();

  runtime.log(`reportResponse: ${safeStringify(reportResponse)}`);

  const evmClient =
    new cre.capabilities.EVMClient(
      ETHEREUM_SEPOLIA_SELECTOR
    );

  runtime.log(`typeof evmClient.writeReport = ${typeof evmClient.writeReport}`);

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

  runtime.log(`writeResp completo: ${safeStringify(writeResp)}`);
  runtime.log(`writeResp txHash: ${txHash || "sem txHash"}`);
  runtime.log(`writeResp txStatus: ${safeStringify((writeResp as any)?.txStatus)}`);
  runtime.log(
    `writeResp receiverContractExecutionStatus: ${safeStringify(
      (writeResp as any)?.receiverContractExecutionStatus
    )}`
  );
  runtime.log(`writeResp errorMessage: ${safeStringify((writeResp as any)?.errorMessage)}`);

  return "REGISTRO_FINALIZADO";
};

export const initWorkflow = (
  config: Config
) => {
  const cron = new CronCapability();

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