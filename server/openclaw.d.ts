declare module "openclaw" {
  export class Gateway {
    constructor(options?: any);
    start(): Promise<void>;
    stop(): Promise<void>;
    sendMessage(params: {
      agent: string;
      message: string;
      channelId: string;
    }): Promise<any>;
  }
}
