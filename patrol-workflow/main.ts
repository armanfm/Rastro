import {
  CronCapability,
  HTTPClient,
  handler,
  Runner,
  consensusIdenticalAggregation,
  type Runtime,
} from "@chainlink/cre-sdk";

import {
  encodeFunctionData,
  decodeFunctionResult,
} from "viem";

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

export type Config = {
  rastroContractAddress: string;
  mapbiomasEmail: string;
  mapbiomasPassword: string;
  pinataJwt: string;
};

// ═══════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════

const MAPBIOMAS_GQL =
  "https://plataforma.alerta.mapbiomas.org/api/v2/graphql";

const RPC_URL =
  "https://ethereum-sepolia-rpc.publicnode.com";

const PINATA_URL =
  "https://api.pinata.cloud/pinning/pinJSONToIPFS";

// ═══════════════════════════════════════
// ABI
// ═══════════════════════════════════════

const ABI = [

  {
    name: "listarTodos",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string[]" }],
  },

  {
    // getter automatico do mapping publico
    // mapping(string => string) public cidTerritorial
    name: "cidTerritorial",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "codigoCAR",
        type: "string",
      },
    ],
    outputs: [{ type: "string" }],
  },

  {
    name: "invalidarCAR",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "codigoCAR",
        type: "string",
      },
    ],
    outputs: [],
  },

  {
    name: "registrarTerritorial",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "codigoCAR",
        type: "string",
      },
      {
        name: "cid",
        type: "string",
      },
    ],
    outputs: [],
  },

] as const;

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

function decodeBody(body: any) {
  return JSON.parse(
    new TextDecoder().decode(body)
  );
}

function encodeBody(data: object) {
  return new TextEncoder().encode(
    JSON.stringify(data)
  );
}

// ═══════════════════════════════════════
// PATROL REGISTRO
// ═══════════════════════════════════════

export const onFazendaCadastrada = (
  runtime: Runtime<Config>
): string => {

  runtime.log(
    "PATROL REGISTRO - VERIFICACAO TERRITORIAL"
  );

  const httpClient =
    new HTTPClient();

  return runtime.runInNodeMode(

    (nodeRuntime: any) => {

      const address =
        runtime.config
          .rastroContractAddress as `0x${string}`;

      // ═══════════════════════════════
      // BUSCA TODOS OS CARS
      // ═══════════════════════════════

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

      const lista =
        decodeFunctionResult({
          abi: ABI,
          functionName: "listarTodos",
          data: decodeBody(rpcResp.body).result,
        }) as unknown as string[];

      runtime.log(
        `Total fazendas: ${lista.length}`
      );

      // ═══════════════════════════════
      // LOGIN MAPBIOMAS
      // ═══════════════════════════════

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
`
            }),
          }
        ).result();

      const token =
        decodeBody(authResp.body)
          ?.data?.signIn?.token;

      if (!token) {
        runtime.log("ERRO LOGIN MAPBIOMAS");
        return "ERRO_LOGIN";
      }

      runtime.log("MapBiomas autenticado");

      // ═══════════════════════════════
      // PROCESSA CADA CAR
      // ═══════════════════════════════

      for (let i = 0; i < lista.length; i++) {

        const codigoCAR =
          lista[i]?.trim().replace(/,/g, "") || "";

        runtime.log(
          `[${i + 1}/${lista.length}] ${codigoCAR}`
        );

        if (!codigoCAR) {
          runtime.log("CAR vazio");
          continue;
        }

        // ═══════════════════════════
        // JA TEM CID TERRITORIAL?
        // ═══════════════════════════

        const cidData =
          encodeFunctionData({
            abi: ABI,
            functionName: "cidTerritorial",
            args: [codigoCAR],
          });

        const cidResp =
          httpClient.sendRequest(
            nodeRuntime,
            {
              url: RPC_URL,
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: encodeBody({
                jsonrpc: "2.0",
                method: "eth_call",
                params: [{ to: address, data: cidData }, "latest"],
                id: 2,
              }),
            }
          ).result();

        const cidAtual =
          decodeFunctionResult({
            abi: ABI,
            functionName: "cidTerritorial",
            data: decodeBody(cidResp.body).result,
          }) as unknown as string;

        if (cidAtual && cidAtual !== "") {
          runtime.log(
            `   Ja tem CID territorial: ${cidAtual} - pula`
          );
          continue;
        }

        // ═══════════════════════════
        // CONSULTA RURAL PROPERTY
        // ═══════════════════════════

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
                variables: { carCode: codigoCAR }
              }),
            }
          ).result();

        const property =
          decodeBody(propertyResp.body)
            ?.data?.ruralProperty;

        // ═══════════════════════════
        // INVALIDO
        // ═══════════════════════════

        if (!property || !property.propertyCode) {
          runtime.log("CAR INVALIDO");
          runtime.log(`invalidarCAR("${codigoCAR}")`);
          continue;
        }

        // ═══════════════════════════
        // VALIDO — PINA CID TERRITORIAL
        // ═══════════════════════════

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

        const cidTerritorial =
          decodeBody(pinataResp.body)?.IpfsHash;

        if (!cidTerritorial) {
          runtime.log("ERRO IPFS - pula");
          continue;
        }

        runtime.log(
          `CID Territorial: ${cidTerritorial}`
        );

        runtime.log(
          `registrarTerritorial("${codigoCAR}", "${cidTerritorial}")`
        );
      }

      return "REGISTRO_FINALIZADO";

    },

    consensusIdenticalAggregation<string>()

  )().result();
};

// ═══════════════════════════════════════
// WORKFLOW
// ═══════════════════════════════════════

export const initWorkflow = (
  config: Config
) => {

  const cron = new CronCapability();

  return [
    handler(
      cron.trigger({
        // roda de hora em hora
        // so processa CARs sem cidTerritorial
        schedule: "0 * * * *",
      }) as any,
      onFazendaCadastrada
    )
  ];
};

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════

export async function main() {
  const runner =
    await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}