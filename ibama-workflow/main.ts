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
  pinataJwt: string;
};

type Embargo = {
  seqTad: string;
  areaHa: number;
  dataEmissao: string;
  situacao: string;
};

const RPC_URL =
  "https://ethereum-sepolia-rpc.publicnode.com";

const IPFS_GATEWAY =
  "https://gateway.pinata.cloud/ipfs";

const IBAMA_URL =
  "https://pamgia.ibama.gov.br/server/rest/services/01_Publicacoes_Bases/adm_embargos_ibama_a/FeatureServer/0/query";

const PINATA_URL =
  "https://api.pinata.cloud/pinning/pinJSONToIPFS";

const DATA_SOURCE =
  "IBAMA PAMGIA via CID Territorial";

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
  address: `0x${string}`,
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

function consultarIBAMA(
  httpClient: HTTPClient,
  nodeRuntime: any,
  boundingBox: number[]
): Embargo[] {
  try {
    const [lonMin, latMin, lonMax, latMax] = boundingBox;

    const rings = [[
      [lonMin, latMin],
      [lonMax, latMin],
      [lonMax, latMax],
      [lonMin, latMax],
      [lonMin, latMin],
    ]];

    const geometry = encodeURIComponent(JSON.stringify({
      rings,
      spatialReference: { wkid: 4326 },
    }));

    nodeRuntime.log(
      `IBAMA boundingBox [${lonMin.toFixed(4)},${latMin.toFixed(4)}] -> [${lonMax.toFixed(4)},${latMax.toFixed(4)}]`
    );

    const resp = httpClient.sendRequest(nodeRuntime, {
      url: `${IBAMA_URL}?geometry=${geometry}&geometryType=esriGeometryPolygon&spatialRel=esriSpatialRelIntersects&inSR=4326&outFields=seq_tad,des_area_embargada,dat_tad,des_situacao_tad&f=json&resultRecordCount=20`,
      method: "GET",
      headers: {},
    }).result();

    const data = decodeBody(resp.body);

    return (data?.features || []).map((f: any) => ({
      seqTad: String(f.attributes?.seq_tad ?? ""),
      areaHa: Number(f.attributes?.des_area_embargada ?? 0),
      dataEmissao: String(f.attributes?.dat_tad ?? ""),
      situacao: String(f.attributes?.des_situacao_tad ?? ""),
    }));
  } catch {
    nodeRuntime.log("IBAMA erro na consulta");
    return [];
  }
}

export const onCronTrigger = (
  runtime: Runtime<Config>
): string => {
  runtime.log("PATROL ANALISE - IBAMA ONLY");

  const httpClient = new HTTPClient();

  const reportData = runtime.runInNodeMode(
    (nodeRuntime: any) => {
      const address =
        runtime.config.rastroContractAddress as `0x${string}`;

      const agora =
        Math.floor(Date.now() / 1000);

      runtime.log(`Contrato: ${address}`);

      const listarData =
        encodeFunctionData({
          abi: ABI,
          functionName: "listarTodos",
        });

      const listarResp =
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

      const lista =
        decodeFunctionResult({
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

      if (!codigoCAR) {
        return "CAR_VAZIO";
      }

      runtime.log(`CAR analisado: ${codigoCAR}`);

      const cidTerritorial =
        lerStringOnchain(
          httpClient,
          nodeRuntime,
          address,
          "cidTerritorial",
          [codigoCAR],
          2
        );

      if (!cidTerritorial) {
        runtime.log("CAR sem cidTerritorial - pula");
        return "SEM_TERRITORIAL";
      }

      runtime.log(`CID Territorial: ${cidTerritorial}`);

      const ipfsResp =
        httpClient.sendRequest(
          nodeRuntime,
          {
            url: `${IPFS_GATEWAY}/${cidTerritorial}`,
            method: "GET",
            headers: {},
          }
        ).result();

      const laudoTerritorial =
        decodeBody(ipfsResp.body);

      const boundingBox: number[] =
        laudoTerritorial?.boundingBox ?? [];

      if (!Array.isArray(boundingBox) || boundingBox.length !== 4) {
        runtime.log("CID territorial sem boundingBox valida");
        return "SEM_BOUNDING_BOX";
      }

      runtime.log(`BoundingBox: ${JSON.stringify(boundingBox)}`);

      const embargos =
        consultarIBAMA(
          httpClient,
          nodeRuntime,
          boundingBox
        );

      const embargoAtivo =
        embargos.filter((e: Embargo) =>
          e.situacao?.toUpperCase().includes("ATIVO")
        ).length;

      const areaEmbargada =
        embargos.reduce(
          (total: number, e: Embargo) =>
            total + Number(e.areaHa ?? 0),
          0
        );

      const embargoStatus =
        embargoAtivo > 0 ? 1 : 0;

      const deforestationStatus =
        0;

      const alertHectares =
        0;

      runtime.log(`IBAMA embargos: ${embargos.length}`);
      runtime.log(`IBAMA embargos ativos: ${embargoAtivo}`);
      runtime.log(`IBAMA area embargada: ${areaEmbargada}ha`);

      const analiseContent = {
        tipo: "analise_ibama",
        codigoCAR,
        cidTerritorial,
        boundingBox,
        deforestationStatus,
        embargoStatus,
        alertHectares,
        ibama: {
          embargos,
          embargoAtivo,
          areaEmbargada,
        },
        dataSource: DATA_SOURCE,
        timestamp: agora,
      };

      const sourceHash =
        keccak256(toBytes(JSON.stringify(analiseContent)));

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
                ...analiseContent,
                sourceHash,
              },
              pinataMetadata: {
                name: `RASTRO-IBAMA-${codigoCAR}`,
              },
            }),
          }
        ).result();

      const cidAnalise =
        decodeBody(pinataResp.body)?.IpfsHash;

      if (!cidAnalise) {
        runtime.log("ERRO IPFS analise IBAMA");
        return "ERRO_IPFS_ANALISE";
      }

      runtime.log(`CID Analise IBAMA: ${cidAnalise}`);

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
            cidAnalise,
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

  runtime.log(`Report IBAMA hex: ${reportData}`);

  const reportFn =
    (runtime as any).report;

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

  return "ANALISE_IBAMA_FINALIZADA";
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