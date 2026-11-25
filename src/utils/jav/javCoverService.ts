import { GM_getValue, GM_setValue } from '$';
import GM_VALUE_KEY from '../../constants/gm.value.key';
import { imageUrl2BlobUrlOfCors } from '../download';
import { GMRequestInstance } from '../request/gmRequst';
import { JAV_SOURCE, JavInfo } from './jav';
import { JavBus } from './javBus';
import { JavDB } from './javDB';

export interface CachedJavInfo extends JavInfo {
    cachedAt: number;
}

type CacheStore = Record<string, CachedJavInfo>;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天缓存
const MAX_CACHE_ENTRIES = 500;
const MAX_CONCURRENCY = 2;
const REQUEST_INTERVAL_MS = 280;

/**
 * 保留原始封面 URL（不直接转成临时 blob: URL，方便持久化缓存）
 */
class RawJavBus extends JavBus {
    async parseInfoAfter(info: JavInfo): Promise<JavInfo> {
        return {
            ...info,
            title: info.title?.replace(new RegExp(`^${info.avNumber}`, 'i'), '').trim(),
            cover: info.cover || '',
        };
    }
}

class JavCoverService {
    private memoryCache = new Map<string, CachedJavInfo | null>();
    private inflight = new Map<string, Promise<CachedJavInfo | null>>();
    private blobUrlCache = new Map<string, Promise<string | undefined>>();
    private queue: Array<() => void> = [];
    private activeCount = 0;
    private storeLoaded = false;
    private persistentStore: CacheStore = {};

    private ensureStoreLoaded() {
        if (this.storeLoaded) return;
        this.storeLoaded = true;
        try {
            const saved = GM_getValue(GM_VALUE_KEY.JAV_COVER_CACHE, {}) as CacheStore;
            if (saved && typeof saved === 'object') {
                const now = Date.now();
                for (const [key, val] of Object.entries(saved)) {
                    if (
                        val &&
                        typeof val === 'object' &&
                        val.cover &&
                        !val.cover.startsWith('blob:') &&
                        now - (val.cachedAt || 0) < CACHE_TTL_MS
                    ) {
                        this.persistentStore[key] = val;
                        this.memoryCache.set(key, val);
                    }
                }
            }
        } catch (err) {
            console.warn('[115Master] 读取封面缓存失败:', err);
        }
    }

    private saveToPersistentStore(key: string, info: CachedJavInfo) {
        try {
            this.persistentStore[key] = info;
            const entries = Object.entries(this.persistentStore);
            if (entries.length > MAX_CACHE_ENTRIES) {
                entries.sort((a, b) => (b[1].cachedAt || 0) - (a[1].cachedAt || 0));
                this.persistentStore = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
            }
            GM_setValue(GM_VALUE_KEY.JAV_COVER_CACHE, this.persistentStore);
        } catch (err) {
            console.warn('[115Master] 写入封面缓存失败:', err);
        }
    }

    /**
     * 检查是否已有内存或本地持久化缓存（可同步命中免排队）
     */
    getCached(avNumber: string): CachedJavInfo | null | undefined {
        this.ensureStoreLoaded();
        const normalized = avNumber.trim().toUpperCase();
        return this.memoryCache.get(normalized);
    }

    /**
     * 获取番号封面与预览信息（带持久化缓存 + 并发队列限流防封 IP）
     */
    async getJavInfo(avNumber: string): Promise<CachedJavInfo | null> {
        this.ensureStoreLoaded();
        const normalized = avNumber.trim().toUpperCase();

        if (this.memoryCache.has(normalized)) {
            return this.memoryCache.get(normalized) ?? null;
        }

        const existingPromise = this.inflight.get(normalized);
        if (existingPromise) {
            return existingPromise;
        }

        const taskPromise = this.enqueue(() => this.fetchFromSources(normalized)).finally(() => {
            this.inflight.delete(normalized);
        });

        this.inflight.set(normalized, taskPromise);
        return taskPromise;
    }

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const run = async () => {
                this.activeCount++;
                try {
                    const result = await fn();
                    resolve(result);
                } catch (err) {
                    reject(err);
                } finally {
                    setTimeout(() => {
                        this.activeCount--;
                        const next = this.queue.shift();
                        next?.();
                    }, REQUEST_INTERVAL_MS);
                }
            };

            if (this.activeCount < MAX_CONCURRENCY) {
                run();
            } else {
                this.queue.push(run);
            }
        });
    }

    private async fetchFromSources(avNumber: string): Promise<CachedJavInfo | null> {
        // 优先尝试单次直达请求的 JavBus，失败或无封面时回退到 JavDB
        const sources = [
            () => new RawJavBus(GMRequestInstance).getInfoByAvNumber(avNumber),
            () => new JavDB(GMRequestInstance).getInfoByAvNumber(avNumber),
        ];

        for (const fetcher of sources) {
            try {
                const info = await fetcher();
                if (info && (info.cover || (info.preview && info.preview.length > 0))) {
                    const cached: CachedJavInfo = {
                        ...info,
                        avNumber: info.avNumber || avNumber,
                        cachedAt: Date.now(),
                    };
                    this.memoryCache.set(avNumber, cached);
                    this.saveToPersistentStore(avNumber, cached);
                    return cached;
                }
            } catch (err) {
                console.debug(`[115Master] 获取 ${avNumber} 封面源尝试未命中:`, err);
            }
        }

        // 未找到时仅记录在当前页面内存缓存，避免同一页面重复请求，刷新后仍可重试
        this.memoryCache.set(avNumber, null);
        return null;
    }

    /**
     * 判断图片 URL 是否受防盗链限制（如 javbus.com 本站图片必须带对应 Referer）
     */
    needsCorsProxy(imageUrl: string): boolean {
        try {
            const host = new URL(imageUrl).hostname.toLowerCase();
            return host.includes('javbus.com') || host.includes('javcdn');
        } catch {
            return false;
        }
    }

    /**
     * 通过 GM_xmlhttpRequest 带 Referer 获取防盗链图片并缓存 Blob URL
     */
    async resolveProtectedImage(imageUrl: string, refererUrl?: string, source?: JAV_SOURCE): Promise<string | undefined> {
        if (!imageUrl) return undefined;
        if (imageUrl.startsWith('blob:') || imageUrl.startsWith('data:')) return imageUrl;

        const existing = this.blobUrlCache.get(imageUrl);
        if (existing) return existing;

        const fallbackReferer =
            refererUrl ||
            (source === JAV_SOURCE.JAVDB ? 'https://www.javdb.com/' : 'https://www.javbus.com/');

        const promise = imageUrl2BlobUrlOfCors(imageUrl, fallbackReferer).then((blobUrl) => {
            if (!blobUrl) {
                this.blobUrlCache.delete(imageUrl);
            }
            return blobUrl;
        });

        this.blobUrlCache.set(imageUrl, promise);
        return promise;
    }
}

export const javCoverService = new JavCoverService();

