import {Redis} from 'ioredis';

export type InitOptions = {
  maxRetriesPerRequest?: number;
  timeoutPerRequest?: number;
  isTLS?: boolean;
  port?: number;
  host?: string;
  redisInstance?: Redis;
};
export type Config = {
  cachePrefix?: string;
  host: string;
};
