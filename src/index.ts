import IORedis, {Ok, Redis} from 'ioredis';
import {isFunction, isUndefined} from '@kubric/utils';
import {InitOptions, PromiseWithListener} from './types';

export default class Cache {
  static redisInstance: Redis;

  static timeoutPerRequest?: number;

  static cacheName: string;

  private entities: any;

  static execute(commandPromise) {
    const {timeoutPerRequest} = Cache;
    if (isUndefined(timeoutPerRequest)) {
      return commandPromise;
    }
    const timeoutPromise = new Promise((resolve, reject) =>
      setTimeout(
        () =>
          reject({
            code: 'cache.TIMEOUT',
            timeout: `Unable to execute operation within ${timeoutPerRequest}ms`,
          }),
        timeoutPerRequest
      )
    );
    return Promise.race([commandPromise, timeoutPromise]);
  }

  static async initialize({
    maxRetriesPerRequest,
    timeoutPerRequest,
    isTLS = false,
    port = 6379,
    host = '127.0.0.1',
    redisInstance,
  }: InitOptions): Promise<Redis> {
    Cache.timeoutPerRequest = timeoutPerRequest;
    if (redisInstance) {
      Cache.redisInstance = redisInstance;
      return redisInstance;
    }
    return new Promise((resolve, reject) => {
      Cache.redisInstance = new IORedis({
        host,
        port,
        maxRetriesPerRequest,
        tls: isTLS ? {} : undefined,
      });
      Cache.redisInstance.on('error', reject);
      Cache.redisInstance.on('ready', resolve);
      resolve(Cache.redisInstance);
    });
  }

  static shutdown(): Promise<Ok> {
    if (isFunction(Cache.redisInstance.quit)) {
      return Cache.redisInstance.quit();
    }
    Cache.redisInstance.disconnect();
    return Promise.resolve('OK');
  }

  static getKey(name: string, entity: string, key = ''): string {
    return `${name}.${entity}${key.length > 0 ? `.${key}` : ''}`;
  }

  static parseResult(result: string): any {
    try {
      return JSON.parse(result);
    } catch (e) {
      return result;
    }
  }

  static async get(entity: string, key: string): Promise<any> {
    key = Cache.getKey(Cache.cacheName, entity, key);
    const result = await Cache.execute(Cache.redisInstance.get(key));
    return Cache.parseResult(result);
  }

  static async set(entity: string, expiry, key, value) {
    key = Cache.getKey(Cache.cacheName, entity, key);
    let valueToSet = value;
    try {
      valueToSet = JSON.stringify(value);
    } catch (ex) {
      // error can be ignored
    }
    if (isUndefined(expiry)) {
      await Cache.execute(Cache.redisInstance.set(key, valueToSet));
    } else {
      await Cache.execute(
        Cache.redisInstance.set(key, valueToSet, 'EX', expiry)
      );
    }
    return true;
  }

  static async deleteKey(entity: string, key: string): Promise<number> {
    const parsedKey = Cache.getKey(Cache.cacheName, entity, key);
    return Cache.redisInstance.del(parsedKey);
  }

  /**
   * To create/update a hash in redis
   * @param entity
   * @param key
   * @param value
   * @returns {Promise<boolean>} - Promise that resolves to true if the value was newly written.
   */
  static async setHashValue(
    entity: string,
    setKey: string,
    field: string,
    value: string
  ): Promise<boolean> {
    const hashKey = Cache.getKey(Cache.cacheName, entity, setKey);
    const result = await Cache.redisInstance.hset(hashKey, field, value);
    return result === 1;
  }

  static getHashValue(entity, setKey, field) {
    const hashKey = Cache.getKey(Cache.cacheName, entity, setKey);
    return Cache.redisInstance.hget(hashKey, field);
  }

  static getHashSet(entity, setKey, asArray = false) {
    const setName = Cache.getKey(Cache.cacheName, entity, setKey);
    return Cache.redisInstance.hgetall(setName).then((results) =>
      Object.keys(results).reduce(
        (acc, key) => {
          const result = Cache.parseResult(results[key]);
          Array.isArray(acc) ? acc.push(result) : (acc[key] = result);
          return acc;
        },
        asArray ? [] : {}
      )
    );
  }

  static async deleteHashValue(entity, setKey, field) {
    const hashKey = Cache.getKey(Cache.cacheName, entity, setKey);
    return Cache.redisInstance.hdel(hashKey, field);
  }

  static async deleteHashValues(entity, setKey, keyPattern) {
    const hashKey = Cache.getKey(Cache.cacheName, entity, setKey);
    const stream = Cache.redisInstance.hscanStream(hashKey, {
      match: keyPattern,
    });
    let deleted = 0;
    const promise: PromiseWithListener = new Promise((resolve, reject) => {
      stream.on('data', (keys) => {
        if (keys.length) {
          const pipeline = Cache.redisInstance.pipeline();
          keys.forEach((key, index) => {
            // HSCAN returns an array [field1, value1, field2, value2...].So only even members are taken as keys for
            // deletion
            if (index % 2 === 0) {
              pipeline.hdel(hashKey, key);
              deleted += 1;
            }
          });
          pipeline.exec();
        }
      });
      stream.on('error', (ex) => {
        console.error(ex);
        reject(ex);
      });
      stream.on('end', () => {
        console.info(`Deleted ${deleted} keys`);
        resolve(deleted);
      });
    });
    promise.on = stream.on.bind(stream);
    return promise;
  }

  static async getKeys(entity, keys) {
    if (typeof keys === 'string') {
      keys = [keys];
    }
    const promises = keys.map((key) =>
      Cache.redisInstance
        .get(Cache.getKey(Cache.cacheName, entity, key))
        .then((result) => {
          try {
            return JSON.parse(result ?? '');
          } catch (_err) {
            return result;
          }
        })
    );
    return Promise.all(promises);
  }

  static watchKey(entity, key) {
    return Cache.redisInstance.watch(
      Cache.getKey(Cache.cacheName, entity, key)
    );
  }

  static deleteAll(entity, keyPattern = '*') {
    const stream = Cache.redisInstance.scanStream({
      match: Cache.getKey(Cache.cacheName, entity, keyPattern),
    });
    let deleted = 0;
    const promise: PromiseWithListener = new Promise((resolve, reject) => {
      stream.on('data', (keys) => {
        if (keys.length) {
          const pipeline = Cache.redisInstance.pipeline();
          keys.forEach((key) => {
            pipeline.del(key);
            deleted += 1;
          });
          pipeline.exec();
        }
      });
      stream.on('error', (ex) => {
        console.error(ex);
        reject(ex);
      });
      stream.on('end', () => {
        console.info(`Deleted ${deleted} keys`);
        resolve(deleted);
      });
    });
    promise.on = stream.on.bind(stream);
    return promise;
  }

  unwatch(): Promise<string> {
    return Cache.redisInstance.unwatch();
  }

  getRedisInstance(): Redis {
    return Cache.redisInstance;
  }

  constructor(options: Record<string, never> = {}) {
    this.entities = options.entities || [];
    Cache.cacheName = options.cachePrefix;

    Object.keys(this.entities).forEach((entity) => {
      const entityObj = this.entities[entity];
      let name = entityObj;
      let expiry = null;
      let isHash = false;
      if (typeof entityObj !== 'string') {
        name = entityObj.name;
        expiry = entityObj.expiry;
        isHash = entityObj.isHash;
      }

      this[`get${name}`] = Cache.get.bind(this, entity);
      this[`set${name}`] = Cache.set.bind(this, entity, expiry);
      this[`delete${name}`] = Cache.deleteKey.bind(this, entity);
      this[`deleteAll${name}`] = Cache.deleteAll.bind(this, entity);
      this[`get${name}s`] = Cache.getKeys.bind(this, entity);
      this[`watch${name}`] = Cache.watchKey.bind(this, entity);
      this[`unwatch${name}`] = this.unwatch.bind(this, entity);
      if (isHash) {
        this[`get${name}Set`] = Cache.getHashSet.bind(this, entity);
        this[`get${name}Value`] = Cache.getHashValue.bind(this, entity);
        this[`set${name}Value`] = Cache.setHashValue.bind(this, entity);
        this[`delete${name}Value`] = Cache.deleteHashValue.bind(this, entity);
        this[`delete${name}Values`] = Cache.deleteHashValues.bind(
          Cache,
          this,
          entity
        );
      }
    });
  }
}
