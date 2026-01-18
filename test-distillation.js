#!/usr/bin/env node
/**
 * 网页快照测试脚本 - 支持 ARIA 和蒸馏模式对比
 *
 * 用法:
 *   node test-distillation.js <url>                                         # 默认 ARIA 模式
 *   PLAYWRIGHT_MCP_SNAPSHOT_MODE=optimized node test-distillation.js <url>  # 蒸馏模式
 */

import { chromium } from 'playwright';

// 获取快照模式
const snapshotMode = process.env.PLAYWRIGHT_MCP_SNAPSHOT_MODE || 'aria';

// ARIA Snapshot - 使用 Playwright 内置的 _snapshotForAI API
async function captureAriaSnapshot(page) {
  return await page._snapshotForAI();
}

// 与 src/domOptimizer.ts 完全一致的蒸馏逻辑（使用 Playwright frame API 支持跨域 iframe）
async function captureOptimizedSnapshot(page, options = {}) {
  const opts = {
    viewportBuffer: options.viewportBuffer ?? 1000,
    maxTextLength: options.maxTextLength ?? 100,
    includeHidden: options.includeHidden ?? false,
    minWidth: options.minElementSize?.width ?? 1,
    minHeight: options.minElementSize?.height ?? 1,
  };

  // 使用 Playwright 的 frame API 获取所有 frame（包括跨域 iframe）
  const allFrames = page.frames();
  const allResults = [];
  let globalIdCounter = 1;

  for (const frame of allFrames) {
    try {
      // 跳过已分离的 frame
      if (frame.isDetached()) continue;

      // 计算 frame 相对于主页面的偏移
      let frameOffsetX = 0;
      let frameOffsetY = 0;

      let currentFrame = frame;
      while (currentFrame !== page.mainFrame()) {
        const parentFrame = currentFrame.parentFrame();
        if (!parentFrame) break;

        try {
          const frameElement = await currentFrame.frameElement();
          if (frameElement) {
            const box = await frameElement.boundingBox();
            if (box) {
              frameOffsetX += box.x;
              frameOffsetY += box.y;
            }
          }
        } catch {
          // Frame element 不可访问
        }
        currentFrame = parentFrame;
      }

      // 在当前 frame 中执行蒸馏
      const frameResult = await frame.evaluate((evalOpts) => {
        const {
          viewportBuffer,
          maxTextLength,
          includeHidden,
          minWidth,
          minHeight,
          startId,
          frameOffsetX,
          frameOffsetY,
        } = evalOpts;

        let idCounter = startId;
        const distilledHTML = [];
        const elementMap = [];

        const interactiveSelectors = [
          'a[href]', 'button', 'input', 'textarea', 'select',
          '[role="button"]', '[role="link"]', '[role="tab"]',
          '[role="menuitem"]', '[role="option"]', '[onclick]',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'label', '[aria-label]', '[title]'
        ];

        const viewportHeight = window.innerHeight;
        const scrollY = window.scrollY;
        const elements = document.querySelectorAll(interactiveSelectors.join(','));

        elements.forEach((el) => {
          const rect = el.getBoundingClientRect();
          const computed = window.getComputedStyle(el);

          if (rect.width < minWidth || rect.height < minHeight) return;

          if (!includeHidden) {
            if (computed.display === 'none' || computed.visibility === 'hidden' ||
              parseFloat(computed.opacity) === 0) return;

            const absoluteTop = rect.top + scrollY + frameOffsetY;
            const absoluteBottom = rect.bottom + scrollY + frameOffsetY;
            const viewportTop = scrollY - viewportBuffer;
            const viewportBottom = scrollY + viewportHeight + viewportBuffer;

            if (absoluteBottom < viewportTop || absoluteTop > viewportBottom) return;
          }

          const mcpId = idCounter++;
          el.setAttribute('data-mcp-id', String(mcpId));

          let text = el.innerText || el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') || el.getAttribute('title') ||
            el.getAttribute('alt') || el.value || '';
          text = text.replace(/\s+/g, ' ').trim().slice(0, maxTextLength);

          const tagName = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const type = el.getAttribute('type');
          const name = el.getAttribute('name');

          let html = `<${tagName} id="${mcpId}"`;
          if (role) html += ` role="${role}"`;
          if (type) html += ` type="${type}"`;
          if (name) html += ` name="${name}"`;
          html += text ? `>${text}</${tagName}>` : ' />';

          distilledHTML.push(html);
          elementMap.push({
            mcpId, tagName, text, role: role || undefined,
            bounds: {
              x: rect.x + frameOffsetX,
              y: rect.y + frameOffsetY,
              width: rect.width,
              height: rect.height
            }
          });
        });

        return {
          distilledHTML,
          elementMap,
          totalElements: elements.length,
          nextId: idCounter
        };
      }, {
        ...opts,
        startId: globalIdCounter,
        frameOffsetX,
        frameOffsetY,
      });

      globalIdCounter = frameResult.nextId;
      allResults.push(frameResult);

    } catch (error) {
      console.warn(`处理 frame 时出错: ${error.message}`);
    }
  }

  // 合并所有 frame 的结果
  const mergedDistilledHTML = [];
  const mergedElementMap = [];
  let totalElements = 0;

  for (const result of allResults) {
    mergedDistilledHTML.push(...result.distilledHTML);
    mergedElementMap.push(...result.elementMap);
    totalElements += result.totalElements;
  }

  return {
    distilledHTML: mergedDistilledHTML.join('\n'),
    elementMap: mergedElementMap,
    totalElements,
    visibleElements: mergedElementMap.length
  };
}

// 模拟 MCP 的页面等待策略
async function waitLikeMCP(page) {
  // 1. 等待 load 事件（最多 5 秒）- 与 tab.ts:198 一致
  try {
    await page.waitForLoadState('load', { timeout: 5000 });
  } catch (e) {
    console.log('Load 事件超时（5秒），继续执行...');
  }

  // 2. 等待网络空闲（最多 3 秒）- 简化版的 waitForCompletion
  try {
    await page.waitForLoadState('networkidle', { timeout: 3000 });
  } catch (e) {
    console.log('网络空闲超时，继续执行...');
  }

  // 3. 额外等待 1 秒 - 与 utils.ts:67 一致
  await page.waitForTimeout(1000);
}

async function main() {
  const url = process.argv[2] || 'https://www.baidu.com';

  console.log(`=== 网页快照测试 ===`);
  console.log(`模式: ${snapshotMode.toUpperCase()}`);
  console.log(`目标 URL: ${url}\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 模拟 MCP navigate 行为
  console.log('正在加载页面...');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('等待页面稳定...');
  await waitLikeMCP(page);

  console.log('正在捕获快照...\n');

  if (snapshotMode === 'optimized') {
    // 蒸馏模式
    const result = await captureOptimizedSnapshot(page);

    console.log('=== 蒸馏结果 ===\n');
    console.log(`总元素数: ${result.totalElements}`);
    console.log(`可见元素数: ${result.visibleElements}`);
    console.log(`过滤率: ${((1 - result.visibleElements / result.totalElements) * 100).toFixed(1)}%\n`);

    console.log('--- 蒸馏后的 HTML ---\n');
    console.log(result.distilledHTML);

    console.log('\n--- 元素元数据（前5个）---\n');
    console.log(JSON.stringify(result.elementMap.slice(0, 5), null, 2));
  } else {
    // ARIA 模式（默认）
    const snapshot = await captureAriaSnapshot(page);

    console.log('=== ARIA Snapshot ===\n');
    console.log(`字符数: ${snapshot.length}`);
    console.log(`行数: ${snapshot.split('\n').length}\n`);

    console.log('--- ARIA Snapshot 内容 ---\n');
    console.log(snapshot);
  }

  await browser.close();
}

main().catch(console.error);
