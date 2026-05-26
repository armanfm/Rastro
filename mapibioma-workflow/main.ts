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
  keccak256,
  toBytes,
  bytesToHex,
} from "viem";

export type Config = {
  rastroContractAddress: string;
  geminiKey: string;
  pinataJwt: string;
  mapbiomasEmail: string;
  mapbiomasPassword: string;
};

const MAPBIOMAS_GQL = "https://plataforma.alerta.mapbiomas.org/api/v2/graphql";
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const PINATA_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const DATA_SOURCE = "MapBiomas Alerta v2";
const ETHEREUM_SEPOLIA_SELECTOR = BigInt("16015286601757825753");

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

const REPORT_ANALISE_PARAMS = [
  { name: "action", type: "uint8" },
  { name: "codigoCAR", type: "string" },
  {
    name: "dados",
    type: "tuple",
    components: [
      { name: "deforestationStatus", type: "uint8" },
      { name: "embargoStatus", type: "uint8" },
      { name: "alertHectares", type: "uint256" },
      { name: "dataSource", type: "string" },
      { name: "sourceHash", type: "bytes32" },
      { name: "cidAnalise", type: "string" },
      { name: "cidGemini", type: "string" },
    ],
  },
] as const;

function encodeBody(data: object) {
  return new TextEncoder().encode(JSON.stringify(data));
}

function decodeBody(body: any) {
  return JSON.parse(new TextDecoder().decode(body));
}

function safeStringify(value: any) {
  try {
    return JSON.stringify(value, (_key, val) =>
      typeof val === "bigint" ? val.toString() : val
    );
  } catch {
    return String(value);
  }
}

function txHashToString(txHash: any) {
  if (!txHash) return "";
  if (typeof txHash === "string") return txHash;

  try {
    return bytesToHex(txHash);
  } catch {
    return safeStringify(txHash);
  }
}

function hexToBase64(hex: string) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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
    out += b2 === undefined ? "=" : alphabet[((b2 & 15) << 2) | ((b3 ?? 0) >> 6)];
    out += b3 === undefined ? "=" : alphabet[b3 & 63];
  }

  return out;
}

function lerStringOnchain(
  httpClient: HTTPClient,
  nodeRuntime: any,
  address: string,
  functionName: "cidTerritorial",
  args: [string],
  id: number
): string {
  try {
    const data = encodeFunctionData({
      abi: ABI,
      functionName,
      args,
    });

    const resp = httpClient.sendRequest(nodeRuntime, {
      url: RPC_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBody({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: address, data }, "latest"],
        id,
      }),
    }).result();

    const json = decodeBody(resp.body);

    if (json?.error || !json?.result) {
      return "";
    }

    return decodeFunctionResult({
      abi: ABI,
      functionName,
      data: json.result,
    }) as unknown as string;
  } catch {
    return "";
  }
}

export const onCronTrigger = (
  runtime: Runtime<Config>
): string => {
  runtime.log("PATROL ANALISE - BUSCA CAR ON-CHAIN");

  const httpClient = new HTTPClient();

  const reportData = runtime.runInNodeMode(
    (nodeRuntime: any) => {
      const address = runtime.config.rastroContractAddress as `0x${string}`;
      const agora = Math.floor(Date.now() / 1000);

      runtime.log(`Contrato: ${address}`);

      const listarData = encodeFunctionData({
        abi: ABI,
        functionName: "listarTodos",
      });

      const listarResp = httpClient.sendRequest(nodeRuntime, {
        url: RPC_URL,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: encodeBody({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: address, data: listarData }, "latest"],
          id: 1,
        }),
      }).result();

      const lista = decodeFunctionResult({
        abi: ABI,
        functionName: "listarTodos",
        data: decodeBody(listarResp.body).result,
      }) as unknown as string[];

      runtime.log(`Total fazendas on-chain: ${lista.length}`);

      if (lista.length === 0) {
        return "SEM_FAZENDAS";
      }

      const codigoCAR =
        lista[0]?.trim().replace(/,/g, "") || "";

      runtime.log(`CAR vindo do contrato: ${codigoCAR}`);

      if (!codigoCAR) {
        return "CAR_VAZIO";
      }

      const cidTerritorial = lerStringOnchain(
        httpClient,
        nodeRuntime,
        address,
        "cidTerritorial",
        [codigoCAR],
        2
      );

      if (!cidTerritorial) {
        runtime.log("CAR ainda nao tem cidTerritorial - pula analise");
        return "SEM_TERRITORIAL";
      }

      runtime.log(`CID territorial on-chain: ${cidTerritorial}`);

      const authResp = httpClient.sendRequest(nodeRuntime, {
        url: MAPBIOMAS_GQL,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: encodeBody({
          query: `mutation {
            signIn(
              email: "${runtime.config.mapbiomasEmail}",
              password: "${runtime.config.mapbiomasPassword}"
            ) { token }
          }`,
        }),
      }).result();

      const token: string =
        decodeBody(authResp.body)?.data?.signIn?.token;

      if (!token) {
        runtime.log("ERRO LOGIN MAPBIOMAS");
        return "ERRO_LOGIN";
      }

      runtime.log("MapBiomas autenticado");

      const propResp = httpClient.sendRequest(nodeRuntime, {
        url: MAPBIOMAS_GQL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: encodeBody({
          query: `query ruralProperty($carCode: String!) {
            ruralProperty(carCode: $carCode) {
              propertyCode
              areaHa
              state
              stateAcronym
              boundingBox
              alerts {
                areaHa
              }
            }
          }`,
          variables: { carCode: codigoCAR },
        }),
      }).result();

      const propJson = decodeBody(propResp.body);

      if (propJson?.errors) {
        runtime.log(`MapBiomas errors: ${JSON.stringify(propJson.errors)}`);
      }

      const propData =
        propJson?.data?.ruralProperty;

      if (!propData?.propertyCode) {
        runtime.log("CAR nao encontrado no MapBiomas");
        return "CAR_NAO_ENCONTRADO";
      }

      runtime.log(`CAR encontrado no MapBiomas: ${propData.propertyCode}`);
      runtime.log(`Area: ${propData.areaHa}ha | Estado: ${propData.stateAcronym}`);

      const alerts =
        Array.isArray(propData.alerts)
          ? propData.alerts
          : [];

      const totalAlerts =
        alerts.length;

      const areaHaAlertas =
        alerts.reduce(
          (total: number, alerta: any) =>
            total + Number(alerta?.areaHa ?? 0),
          0
        );

      const deforestationStatus =
        totalAlerts > 0 ? 1 : 0;

      const embargoStatus =
        0;

      const alertHectares =
        Math.round(areaHaAlertas * 100);

      runtime.log(`Alertas: ${totalAlerts} | ${areaHaAlertas}ha`);
      runtime.log(`deforestationStatus=${deforestationStatus}`);
      runtime.log("embargoStatus=0 nesta versao sem IBAMA para caber no limite de 5 calls");

      const analiseContent = {
        tipo: "analise",
        codigoCAR,
        cidTerritorial,
        propertyCode: propData.propertyCode,
        areaHa: propData.areaHa,
        estado: propData.state,
        stateAcronym: propData.stateAcronym,
        boundingBox: propData.boundingBox,
        numberOfAlerts: totalAlerts,
        areaHaAlertas,
        deforestationStatus,
        embargoStatus,
        alertHectares,
        ibama: {
          consultado: false,
          motivo: "Removido nesta versao para caber no limite de 5 calls do simulador CRE",
        },
        gemini: {
          consultado: false,
          motivo: "Removido nesta versao para caber no limite de 5 calls do simulador CRE",
        },
        dataSource: DATA_SOURCE,
        timestamp: agora,
      };

      const sourceHash =
        keccak256(toBytes(JSON.stringify(analiseContent)));

      const pinataAnalise = httpClient.sendRequest(nodeRuntime, {
        url: PINATA_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${runtime.config.pinataJwt}`,
        },
        body: encodeBody({
          pinataContent: {
            ...analiseContent,
            sourceHash,
          },
          pinataMetadata: {
            name: `RASTRO-ANALISE-${codigoCAR}`,
          },
        }),
      }).result();

      const cidAnaliseNovo: string =
        decodeBody(pinataAnalise.body)?.IpfsHash;

      if (!cidAnaliseNovo) {
        runtime.log("ERRO IPFS analise");
        return "ERRO_IPFS_ANALISE";
      }

      runtime.log(`CID Analise: ${cidAnaliseNovo}`);
      runtime.log("Montando report action=2");

      return encodeAbiParameters(
        REPORT_ANALISE_PARAMS,
        [
          2,
          codigoCAR,
          {
            deforestationStatus,
            embargoStatus,
            alertHectares: BigInt(alertHectares),
            dataSource: DATA_SOURCE,
            sourceHash,
            cidAnalise: cidAnaliseNovo,
            cidGemini: "",
          },
        ]
      );
    },
    consensusIdenticalAggregation<string>()
  )().result();

  if (!reportData || !reportData.startsWith("0x")) {
    runtime.log(`Sem escrita on-chain: ${reportData}`);
    return reportData || "SEM_REPORT";
  }

  runtime.log(`Report analise hex: ${reportData}`);

  const reportFn = (runtime as any).report;

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

  return "ANALISE_FINALIZADA";
};

export const initWorkflow = (
  config: Config
) => {
  const cron = new CronCapability();

  return [
    handler(
      cron.trigger({
        schedule: "0 0 * * 1",
      }) as any,
      onCronTrigger
    ),
  ];
};

export async function main() {
  const runner =
    await Runner.newRunner<Config>();

  await runner.run(initWorkflow);
}