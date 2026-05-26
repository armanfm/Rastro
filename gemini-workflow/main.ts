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
  geminiKey: string;
  pinataJwt: string;
};

type RiscoCalculado = "BAIXO" | "MEDIO" | "ALTO";

type NarrativaGemini = {
  riscoCalculado: RiscoCalculado;
  justificativa: string;
  compliance: string;
  interpretacao: string;
  resumo: string;
  observacao: string;
};

const RPC_URL =
  "https://ethereum-sepolia-rpc.publicnode.com";

const IPFS_GATEWAY =
  "https://gateway.pinata.cloud/ipfs";

const PINATA_URL =
  "https://api.pinata.cloud/pinning/pinJSONToIPFS";

const ETHEREUM_SEPOLIA_SELECTOR =
  BigInt("16015286601757825753");

const GEMINI_MODEL =
  "gemini-3-flash-preview";

const DATA_SOURCE =
  "Gemini sobre CID Analise";

const ABI = [
  {
    name: "listarTodos",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string[]" }],
  },
  {
    name: "cidAnalise",
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

function calcularRiscoDoCidAnalise(
  analise: any
): RiscoCalculado {
  const deforestationStatus =
    Number(analise?.deforestationStatus ?? 0);

  const embargoStatus =
    Number(analise?.embargoStatus ?? 0);

  if (embargoStatus === 1) {
    return "ALTO";
  }

  if (deforestationStatus === 1) {
    return "MEDIO";
  }

  return "BAIXO";
}

function fallbackNarrativa(
  motivo: string,
  analise: any
): NarrativaGemini {
  const riscoCalculado =
    calcularRiscoDoCidAnalise(analise);

  return {
    riscoCalculado,
    justificativa:
      riscoCalculado === "BAIXO"
        ? "Sem alerta ou embargo nas fontes consultadas"
        : riscoCalculado === "MEDIO"
          ? "Alerta ambiental identificado no CID de analise"
          : "Embargo ativo identificado no CID de analise",
    compliance:
      "A avaliacao considera os dados estruturados do CID de analise. O risco foi calculado por regras objetivas sobre deforestationStatus e embargoStatus.",
    interpretacao:
      `O Gemini nao retornou narrativa completa. Motivo: ${motivo}. A interpretacao usa o CID de analise como fonte primaria.`,
    resumo:
      "Relatorio automatico gerado para apoiar due diligence EUDR com base no CID de analise salvo em IPFS.",
    observacao:
      "O risco foi derivado do CID de analise, nao decidido autonomamente pela IA.",
  };
}

function extrairTextoGemini(geminiJson: any): string {
  const parts =
    geminiJson?.candidates?.[0]?.content?.parts;

  if (Array.isArray(parts)) {
    const text =
      parts
        .map((part: any) =>
          typeof part?.text === "string" ? part.text : ""
        )
        .join("")
        .trim();

    if (text) {
      return text;
    }
  }

  const altText =
    geminiJson?.candidates?.[0]?.text ??
    geminiJson?.text ??
    "";

  return typeof altText === "string" ? altText.trim() : "";
}

function limparJsonMarkdown(texto: string): string {
  return texto
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
}

function extrairNarrativaGemini(
  texto: string,
  analise: any
): { narrativa: NarrativaGemini; usouFallback: boolean } {
  const riscoCalculado =
    calcularRiscoDoCidAnalise(analise);

  if (!texto || texto.trim() === "") {
    return {
      narrativa: fallbackNarrativa("resposta vazia", analise),
      usouFallback: true,
    };
  }

  try {
    const parsed =
      JSON.parse(limparJsonMarkdown(texto));

    const narrativa: NarrativaGemini = {
      riscoCalculado,
      justificativa:
        String(parsed?.justificativa ?? "").trim(),
      compliance:
        String(parsed?.compliance ?? "").trim(),
      interpretacao:
        String(parsed?.interpretacao ?? "").trim(),
      resumo:
        String(parsed?.resumo ?? "").trim(),
      observacao:
        String(parsed?.observacao ?? "").trim(),
    };

    if (
      !narrativa.justificativa ||
      !narrativa.compliance ||
      !narrativa.interpretacao ||
      !narrativa.resumo ||
      !narrativa.observacao
    ) {
      return {
        narrativa: fallbackNarrativa(
          "JSON vazio ou campos obrigatorios ausentes",
          analise
        ),
        usouFallback: true,
      };
    }

    return {
      narrativa,
      usouFallback: false,
    };
  } catch {
    return {
      narrativa: fallbackNarrativa(
        "resposta nao era JSON valido",
        analise
      ),
      usouFallback: true,
    };
  }
}

function lerCidAnalise(
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
        functionName: "cidAnalise",
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
      decodeBody(resp.body);

    if (json?.error || !json?.result) {
      return "";
    }

    return decodeFunctionResult({
      abi: ABI,
      functionName: "cidAnalise",
      data: json.result,
    }) as unknown as string;
  } catch {
    return "";
  }
}

export const onCronTrigger = (
  runtime: Runtime<Config>
): string => {
  runtime.log("PATROL GEMINI - CID ANALISE ONLY");

  const httpClient =
    new HTTPClient();

  const reportData =
    runtime.runInNodeMode(
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

        const cidAnalise =
          lerCidAnalise(
            httpClient,
            nodeRuntime,
            address,
            codigoCAR,
            2
          );

        if (!cidAnalise) {
          runtime.log("CAR sem cidAnalise");
          return "SEM_ANALISE";
        }

        runtime.log(`CID Analise: ${cidAnalise}`);

        const ipfsResp =
          httpClient.sendRequest(
            nodeRuntime,
            {
              url: `${IPFS_GATEWAY}/${cidAnalise}`,
              method: "GET",
              headers: {},
            }
          ).result();

        const analise =
          decodeBody(ipfsResp.body);

        runtime.log("CID Analise carregado do IPFS");

        const riscoCalculado =
          calcularRiscoDoCidAnalise(analise);

        const dadosResumidos = {
          codigoCAR,
          cidAnalise,
          deforestationStatus: Number(analise?.deforestationStatus ?? 0),
          embargoStatus: Number(analise?.embargoStatus ?? 0),
          alertHectares: Number(analise?.alertHectares ?? 0),
          numberOfAlerts: Number(analise?.numberOfAlerts ?? 0),
          areaHaAlertas: Number(analise?.areaHaAlertas ?? 0),
          dataSource: String(analise?.dataSource ?? ""),
          ibama: analise?.ibama ?? null,
        };

        const prompt = `Responda somente JSON valido.
Nao use markdown.
Nao invente dados.
O risco ja foi calculado pelos dados estruturados.
Risco calculado: ${riscoCalculado}.

Explique brevemente para due diligence EUDR.

DADOS:
${JSON.stringify(dadosResumidos)}

Formato obrigatorio:
{
  "riscoCalculado": "${riscoCalculado}",
  "justificativa": "max 120 caracteres",
  "compliance": "analise EUDR objetiva",
  "interpretacao": "interpretacao curta dos dados",
  "resumo": "resumo para importador europeu",
  "observacao": "risco vem do CID de analise, nao da IA"
}`;

        const geminiResp =
          httpClient.sendRequest(
            nodeRuntime,
            {
              url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${runtime.config.geminiKey}`,
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: encodeBody({
                contents: [
                  {
                    role: "user",
                    parts: [{ text: prompt }],
                  },
                ],
                generationConfig: {
                  temperature: 0.1,
                  maxOutputTokens: 450,
                  responseMimeType: "application/json",
                },
              }),
            }
          ).result();

        const geminiJson =
          decodeBody(geminiResp.body);

        runtime.log(
          `Gemini JSON completo: ${safeStringify(geminiJson).slice(0, 1500)}`
        );

        if (geminiJson?.error) {
          runtime.log(
            `Gemini API error: ${JSON.stringify(geminiJson.error)}`
          );
        }

        const texto =
          extrairTextoGemini(geminiJson);

        runtime.log(
          `Gemini texto extraido: ${texto ? texto.slice(0, 800) : "[vazio]"}`
        );

        const { narrativa, usouFallback } =
          extrairNarrativaGemini(texto, analise);

        runtime.log(`Risco calculado: ${narrativa.riscoCalculado}`);
        runtime.log(`Gemini usou fallback: ${usouFallback}`);
        runtime.log(`Gemini justificativa: ${narrativa.justificativa}`);

        const geminiContent = {
          tipo: "gemini",
          modelo: GEMINI_MODEL,
          codigoCAR,
          cidAnalise,
          narrativa,
          usouFallback,
          dataSource: DATA_SOURCE,
          timestamp: agora,
        };

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
                pinataContent: geminiContent,
                pinataMetadata: {
                  name: `RASTRO-GEMINI-${codigoCAR}`,
                },
              }),
            }
          ).result();

        const cidGemini =
          decodeBody(pinataResp.body)?.IpfsHash;

        if (!cidGemini) {
          runtime.log("ERRO IPFS Gemini");
          return "ERRO_IPFS_GEMINI";
        }

        runtime.log(`CID Gemini: ${cidGemini}`);

        const deforestationStatus =
          Number(analise?.deforestationStatus ?? 0);

        const embargoStatus =
          Number(analise?.embargoStatus ?? 0);

        const alertHectares =
          BigInt(Number(analise?.alertHectares ?? 0));

        const sourceHash =
          typeof analise?.sourceHash === "string" &&
          analise.sourceHash.startsWith("0x")
            ? analise.sourceHash
            : "0x0000000000000000000000000000000000000000000000000000000000000000";

        runtime.log("Montando report action=2 com cidGemini");

        return encodeAbiParameters(
          REPORT_ANALISE_PARAMS,
          [
            2,
            codigoCAR,
            {
              deforestationStatus,
              embargoStatus,
              alertHectares,
              dataSource: DATA_SOURCE,
              sourceHash,
              cidAnalise,
              cidGemini,
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

  runtime.log(`Report Gemini hex: ${reportData}`);

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

  return "GEMINI_FINALIZADO";
};

export const initWorkflow = (
  config: Config
) => {
  const cron =
    new CronCapability();

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