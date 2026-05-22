declare module '@chainlink/cre-sdk' {
  export class HTTPClient {
    sendRequest(nodeRuntime: any, config: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: Uint8Array;
    }): { result: () => { body: Uint8Array } };
  }

  export function handler(trigger: any, callback: Function): any;
  
  export class Runner {
    static newRunner<T>(): Promise<Runner>;
    run(initFn: Function): Promise<void>;
  }

  export function consensusIdenticalAggregation<T>(): any;
  
  export const cre: {
    capabilities: {
      EVMClient: any;
    };
  };

  export function getNetwork(config: {
    chainFamily: string;
    chainSelectorName: string;
    isTestnet: boolean;
  }): any;

  export type EVMLog = any;
  export type Runtime<T> = {
    log: (msg: string) => void;
    config: T;
    runInNodeMode: (fn: Function, aggregator: any) => { result: () => any };
  };
}

declare module 'viem' {
  export function encodeFunctionData(config: {
    abi: any;
    functionName: string;
    args?: any[];
  }): string;

  export function decodeFunctionResult(config: {
    abi: any;
    functionName: string;
    data: string;
  }): unknown;
}