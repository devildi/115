import dayjs from 'dayjs';
import PhotoSwipe, { SlideData } from 'photoswipe';
import 'photoswipe/style.css';
import './homeCover.css';
import { getAvNumber } from '../utils/getNumber';
import { CachedJavInfo, javCoverService } from '../utils/jav/javCoverService';

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|wmv|mov|ts|flv|rmvb|m4v|webm|iso|mpg|mpeg|m2ts)$/i;
const PROCESSED_ATTR = 'data-m115-cover-init';

interface GalleryImageEntry {
    displayUrl: string;
    rawUrl: string;
    fallbackUrl?: string;
    isCover?: boolean;
    resolvedBlobUrl?: string;
    naturalWidth?: number;
    naturalHeight?: number;
}

export class HomeCoverEnhancer {
    private intersectionObserver: IntersectionObserver;
    private mutationObserver: MutationObserver;
    private pendingElements = new Map<HTMLElement, { avNumber: string; row: HTMLElement; panel: HTMLElement }>();
    private scanScheduled = false;

    constructor() {
        this.intersectionObserver = new IntersectionObserver(this.handleIntersect.bind(this), {
            root: null,
            rootMargin: '320px 0px',
            threshold: 0.01,
        });

        this.mutationObserver = new MutationObserver(() => {
            this.scheduleScan();
        });

        this.init();
    }

    private init() {
        this.scanFileList();
        if (document.body) {
            this.mutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
            });
        }
    }

    private scheduleScan() {
        if (this.scanScheduled) return;
        this.scanScheduled = true;
        requestAnimationFrame(() => {
            this.scanScheduled = false;
            this.scanFileList();
        });
    }

    private isVideoItem(li: HTMLElement): boolean {
        if (li.getAttribute('file_mode') === '4') return false;
        const title = li.getAttribute('title') || li.querySelector('.file-name')?.textContent || '';
        return (
            li.getAttribute('iv') === '1' ||
            li.querySelector('.duration') !== null ||
            VIDEO_EXT_RE.test(title.trim())
        );
    }

    private scanFileList() {
        const items = document.querySelectorAll<HTMLElement>('li[file_type="1"]:not([' + PROCESSED_ATTR + '])');
        items.forEach((li) => {
            li.setAttribute(PROCESSED_ATTR, '1');
            if (!this.isVideoItem(li)) return;

            const title = li.getAttribute('title') || li.querySelector('.file-name')?.textContent?.trim() || '';
            if (!title) return;

            const avNumber = getAvNumber(title);
            if (!avNumber) return;

            this.mountCoverContainer(li, avNumber);
        });
    }

    /**
     * 锁定列表行内原有的绝对定位元素高度位置，防止 li 高度撑开后复选框/文件图标垂直居中偏移
     */
    private preserveTopRowPositions(li: HTMLElement): number {
        const origHeight = li.offsetHeight || 40;
        li.style.setProperty('--m115-row-height', `${origHeight}px`);

        if (li.closest('.list-thumb')) {
            li.classList.add('m115-has-cover');
            return origHeight;
        }

        const children = Array.from(li.children) as HTMLElement[];
        const snapshots = children.map((child) => {
            const style = window.getComputedStyle(child);
            return {
                el: child,
                position: style.position,
                top: child.offsetTop,
            };
        });

        li.classList.add('m115-has-cover');

        // 如果某子元素因 top: 50% 随着高度变化发生下移，则固定回首行原来的像素位置
        snapshots.forEach(({ el, position, top }) => {
            if (position === 'absolute' && top >= 0 && top <= origHeight && Math.abs(el.offsetTop - top) > 4) {
                el.style.top = `${top}px`;
                el.style.bottom = 'auto';
            }
        });

        return origHeight;
    }

    private ensureStrictBelowTopRow(li: HTMLElement, row: HTMLElement, origHeight: number) {
        if (li.closest('.list-thumb')) return;
        // 如果原列表行内部全部为绝对定位元素导致文档流高度为 0，主动下推画廊容器避免重叠到首行文字上
        if (origHeight >= 28 && row.offsetTop < origHeight - 8) {
            row.style.paddingTop = `${origHeight - row.offsetTop + 4}px`;
        }
    }

    private mountCoverContainer(li: HTMLElement, avNumber: string) {
        // 先检查缓存是否明确无结果，避免无番号结果的条目闪动
        const cached = javCoverService.getCached(avNumber);
        if (cached === null) {
            return;
        }

        const origHeight = this.preserveTopRowPositions(li);

        const row = document.createElement('div');
        row.className = 'm115-cover-row';

        const panel = document.createElement('div');
        panel.className = 'm115-cover-panel';
        row.appendChild(panel);

        // 阻止面板内的点击、双击、按下事件冒泡触发 115 原生勾选或视频跳转播放
        const stopBubble = (e: Event) => {
            e.stopPropagation();
        };
        row.addEventListener('click', stopBubble);
        row.addEventListener('dblclick', stopBubble);
        row.addEventListener('mousedown', stopBubble);

        // 若本地持久化缓存已命中，直接渲染，无需等待懒加载网络请求
        if (cached !== undefined) {
            li.appendChild(row);
            this.ensureStrictBelowTopRow(li, row, origHeight);
            this.renderInfo(panel, avNumber, cached);
            return;
        }

        panel.innerHTML = `
            <div class="m115-cover-status">
                <span class="m115-av-badge">${this.escapeHtml(avNumber)}</span>
                <span class="m115-spinner"></span>
                <span>等待加载封面与预览图…</span>
            </div>
        `;
        li.appendChild(row);
        this.ensureStrictBelowTopRow(li, row, origHeight);

        this.pendingElements.set(li, { avNumber, row, panel });
        this.intersectionObserver.observe(li);
    }

    private handleIntersect(entries: IntersectionObserverEntry[]) {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const li = entry.target as HTMLElement;
            this.intersectionObserver.unobserve(li);

            const task = this.pendingElements.get(li);
            if (!task) continue;
            this.pendingElements.delete(li);

            this.loadAndRender(li, task.avNumber, task.row, task.panel);
        }
    }

    private async loadAndRender(li: HTMLElement, avNumber: string, row: HTMLElement, panel: HTMLElement) {
        const statusText = panel.querySelector('.m115-cover-status span:last-child');
        if (statusText) {
            statusText.textContent = '正在获取封面与预览图…';
        }

        const info = await javCoverService.getJavInfo(avNumber);
        if (!li.isConnected) return;

        if (!info || (!info.cover && (!info.preview || info.preview.length === 0))) {
            row.remove();
            li.classList.remove('m115-has-cover');
            return;
        }

        this.renderInfo(panel, avNumber, info);
    }

    private renderInfo(panel: HTMLElement, avNumber: string, info: CachedJavInfo) {
        const actors = info.actors?.map((a) => a.name).filter(Boolean).slice(0, 4).join(' / ');
        const dateStr = info.date ? dayjs(info.date).format('YYYY-MM-DD') : '';
        const durationStr = info.duration ? `${info.duration} 分钟` : '';
        const scoreStr = info.score ? `★ ${info.score}` : '';
        const displayCode = info.avNumber || avNumber;

        const galleryEntries: GalleryImageEntry[] = [];
        if (info.cover) {
            galleryEntries.push({
                displayUrl: info.cover,
                rawUrl: info.cover,
                isCover: true,
            });
        }

        if (info.preview?.length) {
            for (const item of info.preview.slice(0, 16)) {
                const displayUrl = item.raw || item.thumbnail || '';
                const rawUrl = item.raw || item.thumbnail || '';
                if (!displayUrl) continue;
                galleryEntries.push({
                    displayUrl,
                    rawUrl,
                    fallbackUrl: item.thumbnail && item.thumbnail !== displayUrl ? item.thumbnail : undefined,
                    isCover: false,
                });
            }
        }

        panel.innerHTML = `
            <div class="m115-cover-header">
                <div class="m115-cover-meta-left">
                    <span class="m115-av-badge" title="点击复制番号">${this.escapeHtml(displayCode)}</span>
                    ${actors ? `<span class="m115-meta-tag m115-meta-actor" title="${this.escapeHtml(actors)}">${this.escapeHtml(actors)}</span>` : ''}
                    ${scoreStr ? `<span class="m115-meta-tag m115-meta-score">${this.escapeHtml(scoreStr)}</span>` : ''}
                    ${dateStr ? `<span class="m115-meta-tag">${this.escapeHtml(dateStr)}</span>` : ''}
                    ${durationStr ? `<span class="m115-meta-tag">${this.escapeHtml(durationStr)}</span>` : ''}
                    ${info.title ? `<span class="m115-meta-title" title="${this.escapeHtml(info.title)}">${this.escapeHtml(info.title)}</span>` : ''}
                </div>
                <div class="m115-cover-actions">
                    ${info.url ? `<a class="m115-source-link" href="${this.escapeHtml(info.url)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(info.source)} ↗</a>` : ''}
                    <button type="button" class="m115-collapse-btn">收起</button>
                </div>
            </div>
            <div class="m115-cover-gallery"></div>
        `;

        // 点击番号胶囊复制番号
        const badge = panel.querySelector('.m115-av-badge') as HTMLElement | null;
        badge?.addEventListener('click', () => {
            navigator.clipboard?.writeText(displayCode).then(() => {
                const prev = badge.textContent;
                badge.textContent = `已复制 ${displayCode}`;
                setTimeout(() => {
                    badge.textContent = prev;
                }, 1200);
            });
        });

        // 折叠 / 展开按钮
        const collapseBtn = panel.querySelector('.m115-collapse-btn') as HTMLButtonElement | null;
        collapseBtn?.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('is-collapsed');
            collapseBtn.textContent = collapsed ? '展开封面' : '收起';
        });

        // 填充封面与预览图
        const galleryEl = panel.querySelector('.m115-cover-gallery') as HTMLElement;
        galleryEntries.forEach((entry, index) => {
            const itemEl = document.createElement('div');
            itemEl.className = `m115-gallery-item ${entry.isCover ? 'is-main-cover' : 'is-preview'}`;

            if (entry.isCover) {
                const tag = document.createElement('span');
                tag.className = 'm115-item-badge';
                tag.textContent = '封面';
                itemEl.appendChild(tag);
            }

            const img = document.createElement('img');
            img.alt = entry.isCover ? `${displayCode} 封面` : `${displayCode} 预览 ${index}`;
            img.loading = 'lazy';
            img.decoding = 'async';
            img.referrerPolicy = 'no-referrer';

            img.addEventListener('load', () => {
                img.classList.add('is-loaded');
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    entry.naturalWidth = img.naturalWidth;
                    entry.naturalHeight = img.naturalHeight;
                }
            });

            this.loadImageIntoElement(img, entry, info);

            itemEl.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openLightbox(galleryEntries, index, info);
            });

            itemEl.appendChild(img);
            galleryEl.appendChild(itemEl);
        });
    }

    private async loadImageIntoElement(img: HTMLImageElement, entry: GalleryImageEntry, info: CachedJavInfo) {
        if (javCoverService.needsCorsProxy(entry.displayUrl)) {
            const blobUrl = await javCoverService.resolveProtectedImage(entry.displayUrl, info.url, info.source);
            if (blobUrl) {
                entry.resolvedBlobUrl = blobUrl;
                img.src = blobUrl;
                return;
            }
        }

        // 默认优先用无 Referer 浏览器原生懒加载（dmm.co.jp / jdbstatic.com 秒开），失败时自动走油猴跨域代理兜底
        let retriedWithProxy = false;
        img.addEventListener(
            'error',
            async () => {
                if (retriedWithProxy) return;
                retriedWithProxy = true;
                const targetUrl = entry.fallbackUrl || entry.displayUrl;
                const blobUrl = await javCoverService.resolveProtectedImage(targetUrl, info.url, info.source);
                if (blobUrl) {
                    entry.resolvedBlobUrl = blobUrl;
                    img.src = blobUrl;
                }
            },
            { once: true }
        );

        img.src = entry.displayUrl;
    }

    private async openLightbox(entries: GalleryImageEntry[], startIndex: number, info: CachedJavInfo) {
        const slides: SlideData[] = await Promise.all(
            entries.map(async (entry) => {
                let src = entry.resolvedBlobUrl || entry.rawUrl;
                if (!entry.resolvedBlobUrl && javCoverService.needsCorsProxy(entry.rawUrl)) {
                    const blobUrl = await javCoverService.resolveProtectedImage(entry.rawUrl, info.url, info.source);
                    if (blobUrl) {
                        entry.resolvedBlobUrl = blobUrl;
                        src = blobUrl;
                    }
                }
                return {
                    src,
                    msrc: entry.resolvedBlobUrl || entry.displayUrl,
                    width: entry.naturalWidth || (entry.isCover ? 800 : 1280),
                    height: entry.naturalHeight || (entry.isCover ? 538 : 853),
                };
            })
        );

        const pswp = new PhotoSwipe({
            dataSource: slides,
            index: startIndex,
            wheelToZoom: true,
            bgOpacity: 0.88,
            initialZoomLevel: 'fit',
        });

        // 当切换到尚未测量真实尺寸的高清预览图时，动态探测真实宽高避免拉伸变形
        pswp.on('gettingData', (e) => {
            const { data, index } = e;
            const entry = entries[index];
            if (!entry || (entry.naturalWidth && entry.naturalHeight) || !data.src) return;

            const probe = new Image();
            probe.referrerPolicy = 'no-referrer';
            probe.onload = () => {
                if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
                    entry.naturalWidth = probe.naturalWidth;
                    entry.naturalHeight = probe.naturalHeight;
                    data.width = probe.naturalWidth;
                    data.height = probe.naturalHeight;
                    pswp.refreshSlideContent(index);
                }
            };
            probe.src = data.src;
        });

        pswp.init();
    }

    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}

