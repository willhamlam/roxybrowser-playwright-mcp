/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type * as playwright from 'playwright';
import type { Config } from '../config.js';

/**
 * Options for DOM optimization snapshot capture.
 */
export interface SnapshotOptions {
  /** Include elements within this many pixels above/below viewport (default: 1000) */
  viewportBuffer?: number;
  /** Maximum text length per element (default: 100) */
  maxTextLength?: number;
  /** Include hidden elements - useful for debugging (default: false) */
  includeHidden?: boolean;
  /** Minimum element size in pixels to include (default: 1x1) */
  minElementSize?: { width: number; height: number };
}

/**
 * Metadata for an element captured in the optimized snapshot.
 */
export interface ElementMetadata {
  /** Unique ID assigned to the element (data-mcp-id) */
  mcpId: number;
  /** HTML tag name (e.g., 'button', 'input') */
  tagName: string;
  /** Extracted text content */
  text: string;
  /** ARIA role if present */
  role?: string;
  /** Element's bounding box */
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Result from capturing an optimized DOM snapshot.
 */
export interface OptimizedDOMResult {
  /** Simplified HTML representation for LLM */
  distilledHTML: string;
  /** Metadata for each captured element */
  elementMap: ElementMetadata[];
  /** Total number of elements found */
  totalElements: number;
  /** Number of elements that passed filtering */
  visibleElements: number;
}

/**
 * Captures an optimized DOM snapshot by injecting JavaScript into the page.
 *
 * This function implements DOM distillation + ID mapping inspired by:
 * - page-cleaning.md: Simple JavaScript injection approach
 * - browser-use dom_service.py: Viewport-aware visibility filtering
 *
 * For cross-origin iframes, we use Playwright's frame() API which can access
 * cross-origin frames (unlike JavaScript's iframe.contentDocument).
 *
 * @param page - Playwright page instance
 * @param options - Optimization options
 * @returns Optimized DOM result with distilled HTML and element metadata
 */
export async function captureOptimizedSnapshot(
  page: playwright.Page,
  options: SnapshotOptions = {}
): Promise<OptimizedDOMResult> {
  // Apply defaults
  const opts = {
    viewportBuffer: options.viewportBuffer ?? 1000,
    maxTextLength: options.maxTextLength ?? 100,
    includeHidden: options.includeHidden ?? false,
    minWidth: options.minElementSize?.width ?? 1,
    minHeight: options.minElementSize?.height ?? 1,
  };

  // Get all frames (including cross-origin iframes) using Playwright's API
  const allFrames = page.frames();

  // Collect elements from all frames
  const allResults: {
    distilledHTML: string[];
    elementMap: ElementMetadata[];
    totalElements: number;
  }[] = [];

  // Global ID counter across all frames
  let globalIdCounter = 1;

  for (const frame of allFrames) {
    try {
      // Skip frames that are detached or not ready
      if (frame.isDetached()) continue;

      // Get frame's position relative to main page (for coordinate adjustment)
      let frameOffsetX = 0;
      let frameOffsetY = 0;

      // Calculate cumulative offset from parent frames
      let currentFrame = frame;
      while (currentFrame !== page.mainFrame()) {
        const parentFrame = currentFrame.parentFrame();
        if (!parentFrame) break;

        try {
          // Get the iframe element in the parent frame
          const frameElement = await currentFrame.frameElement();
          if (frameElement) {
            const box = await frameElement.boundingBox();
            if (box) {
              frameOffsetX += box.x;
              frameOffsetY += box.y;
            }
          }
        } catch {
          // Frame element not accessible, skip offset calculation
        }
        currentFrame = parentFrame;
      }

      // Process this frame
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
        const distilledHTML: string[] = [];
        const elementMap: Array<{
          mcpId: number;
          tagName: string;
          text: string;
          role?: string;
          bounds: { x: number; y: number; width: number; height: number };
        }> = [];

        // Interactive element selectors
        const interactiveSelectors = [
          'a[href]',
          'button',
          'input',
          'textarea',
          'select',
          '[role="button"]',
          '[role="link"]',
          '[role="tab"]',
          '[role="menuitem"]',
          '[role="option"]',
          '[onclick]',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'label',
          '[aria-label]',
          '[title]',
        ];

        // Get viewport info from the main window (approximation)
        const viewportHeight = window.innerHeight;
        const scrollY = window.scrollY;

        // Find all potentially interactive elements in this frame only
        const elements = document.querySelectorAll(interactiveSelectors.join(','));

        elements.forEach((el) => {
          const rect = el.getBoundingClientRect();
          const computed = window.getComputedStyle(el);

          // Size check
          if (rect.width < minWidth || rect.height < minHeight) return;

          if (!includeHidden) {
            // CSS visibility checks
            if (
              computed.display === 'none' ||
              computed.visibility === 'hidden' ||
              parseFloat(computed.opacity) === 0
            ) {
              return;
            }

            // Viewport intersection with buffer
            // Adjust coordinates for frame offset
            const absoluteTop = rect.top + scrollY + frameOffsetY;
            const absoluteBottom = rect.bottom + scrollY + frameOffsetY;
            const viewportTop = scrollY - viewportBuffer;
            const viewportBottom = scrollY + viewportHeight + viewportBuffer;

            if (absoluteBottom < viewportTop || absoluteTop > viewportBottom) {
              return;
            }
          }

          // Assign unique ID
          const mcpId = idCounter++;
          el.setAttribute('data-mcp-id', String(mcpId));

          // Extract text
          let text =
            (el as HTMLElement).innerText ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('title') ||
            el.getAttribute('alt') ||
            (el as HTMLInputElement).value ||
            '';
          text = text.replace(/\s+/g, ' ').trim().slice(0, maxTextLength);

          // Build simplified representation
          const tagName = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const type = el.getAttribute('type');
          const name = el.getAttribute('name');

          let html = `<${tagName}`;
          html += ` id="${mcpId}"`;
          if (role) html += ` role="${role}"`;
          if (type) html += ` type="${type}"`;
          if (name) html += ` name="${name}"`;

          if (text) {
            html += `>${text}</${tagName}>`;
          } else {
            html += ' />';
          }

          distilledHTML.push(html);

          // Store element metadata (with adjusted coordinates)
          elementMap.push({
            mcpId,
            tagName,
            text,
            role: role || undefined,
            bounds: {
              x: rect.x + frameOffsetX,
              y: rect.y + frameOffsetY,
              width: rect.width,
              height: rect.height,
            },
          });
        });

        return {
          distilledHTML,
          elementMap,
          totalElements: elements.length,
          nextId: idCounter,
        };
      }, {
        ...opts,
        startId: globalIdCounter,
        frameOffsetX,
        frameOffsetY,
      });

      // Update global ID counter for next frame
      globalIdCounter = frameResult.nextId;

      allResults.push({
        distilledHTML: frameResult.distilledHTML,
        elementMap: frameResult.elementMap,
        totalElements: frameResult.totalElements,
      });

    } catch (error) {
      // Frame may have been detached or navigation occurred
      // eslint-disable-next-line no-console
      console.warn(`Error processing frame: ${error}`);
    }
  }

  // Merge results from all frames
  const mergedDistilledHTML: string[] = [];
  const mergedElementMap: ElementMetadata[] = [];
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
    visibleElements: mergedElementMap.length,
  };
}

/**
 * Legacy single-frame implementation (kept for reference).
 * Use captureOptimizedSnapshot instead which handles cross-origin iframes.
 */
export async function captureOptimizedSnapshotSingleFrame(
  page: playwright.Page,
  options: SnapshotOptions = {}
): Promise<OptimizedDOMResult> {
  // Apply defaults
  const opts = {
    viewportBuffer: options.viewportBuffer ?? 1000,
    maxTextLength: options.maxTextLength ?? 100,
    includeHidden: options.includeHidden ?? false,
    minWidth: options.minElementSize?.width ?? 1,
    minHeight: options.minElementSize?.height ?? 1,
  };

  // Inject optimization script into the page
  const result = await page.evaluate((options) => {
    // This function runs in the browser context
    const {
      viewportBuffer,
      maxTextLength,
      includeHidden,
      minWidth,
      minHeight,
    } = options;

    let idCounter = 1;
    const distilledHTML: string[] = [];
    const elementMap: ElementMetadata[] = [];

    // Interactive element selectors (from page-cleaning.md)
    const interactiveSelectors = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[onclick]',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', // Headers for structure
      'label', // Form labels
      '[aria-label]', // Elements with accessible names
      '[title]', // Elements with title tooltips
    ];

    // Get viewport info
    const viewportHeight = window.innerHeight;
    const scrollY = window.scrollY;

    /**
     * Recursively collect elements from all same-origin iframes.
     * This solves the problem where login forms (like 163 mail) are inside iframes.
     *
     * @param doc - The document to search in
     * @param selectors - Array of CSS selectors
     * @param iframeChain - Array of parent iframes for coordinate calculation
     * @param depth - Current recursion depth
     * @returns Array of elements with iframe chain metadata
     */
    interface ElementWithIframeInfo extends Element {
      __iframeChain?: HTMLIFrameElement[];
    }

    function collectAllElements(
      doc: Document,
      selectors: string[],
      iframeChain: HTMLIFrameElement[] = [],
      depth: number = 0
    ): ElementWithIframeInfo[] {
      const MAX_DEPTH = 10; // Prevent infinite recursion

      if (depth > MAX_DEPTH) {
        console.warn(`iframe nesting too deep (>${MAX_DEPTH}), stopping recursion`);
        return [];
      }

      const allElements: ElementWithIframeInfo[] = [];

      // 1. Collect elements from current document
      try {
        const elements = doc.querySelectorAll(selectors.join(','));

        // Attach iframe chain info for coordinate calculation
        Array.from(elements).forEach((el) => {
          (el as ElementWithIframeInfo).__iframeChain = iframeChain;
        });

        allElements.push(...(Array.from(elements) as ElementWithIframeInfo[]));
      } catch (error) {
        console.warn('Error querying elements:', error);
      }

      // 2. Recursively process all iframes
      try {
        const iframes = doc.querySelectorAll('iframe');
        Array.from(iframes).forEach((iframe) => {
          try {
            // Try to access iframe's document (will throw if cross-origin)
            const iframeDoc = (iframe as HTMLIFrameElement).contentDocument ||
                             (iframe as HTMLIFrameElement).contentWindow?.document;

            if (!iframeDoc) return;

            // Recursively collect elements, extending iframe chain
            const newChain = [...iframeChain, iframe as HTMLIFrameElement];
            const iframeElements = collectAllElements(
              iframeDoc,
              selectors,
              newChain,
              depth + 1
            );
            allElements.push(...iframeElements);

          } catch (error) {
            // Cross-origin iframe - safely skip, log warning
            const src = (iframe as HTMLIFrameElement).src || '(no src)';
            console.warn(`Cannot access iframe (cross-origin): ${src}`);
          }
        });
      } catch (error) {
        console.warn('Error iterating iframes:', error);
      }

      return allElements;
    }

    // Find all potentially interactive elements (including from iframes)
    const elements = collectAllElements(document, interactiveSelectors);
    const totalElementsCount = elements.length;

    elements.forEach((el) => {
      // Visibility filtering (inspired by browser-use dom_service.py)
      const rect = el.getBoundingClientRect();
      const computed = window.getComputedStyle(el);

      // Size check
      if (rect.width < minWidth || rect.height < minHeight) return;

      if (!includeHidden) {
        // CSS visibility checks
        if (
          computed.display === 'none' ||
          computed.visibility === 'hidden' ||
          parseFloat(computed.opacity) === 0
        ) {
          return;
        }

        // Calculate cumulative iframe offset for viewport check
        const iframeChain = el.__iframeChain || [];
        let iframeOffsetY = 0;
        let iframeOffsetX = 0;
        iframeChain.forEach((iframe) => {
          const iframeRect = iframe.getBoundingClientRect();
          iframeOffsetY += iframeRect.top;
          iframeOffsetX += iframeRect.left;
        });

        // Viewport intersection with buffer (browser-use approach)
        // Adjusted for iframe offset
        const absoluteTop = rect.top + scrollY + iframeOffsetY;
        const absoluteBottom = rect.bottom + scrollY + iframeOffsetY;
        const viewportTop = scrollY - viewportBuffer;
        const viewportBottom = scrollY + viewportHeight + viewportBuffer;

        if (absoluteBottom < viewportTop || absoluteTop > viewportBottom) {
          return;
        }
      }

      // Clean up temporary property
      delete el.__iframeChain;

      // Assign unique ID
      const mcpId = idCounter++;
      el.setAttribute('data-mcp-id', String(mcpId));

      // Extract text (multiple sources)
      let text =
        (el as HTMLElement).innerText ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        (el as HTMLInputElement).value ||
        '';
      text = text.replace(/\s+/g, ' ').trim().slice(0, maxTextLength);

      // Build simplified representation
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const type = el.getAttribute('type');
      const name = el.getAttribute('name');

      let html = `<${tagName}`;
      html += ` id="${mcpId}"`;
      if (role) html += ` role="${role}"`;
      if (type) html += ` type="${type}"`;
      if (name) html += ` name="${name}"`;

      if (text) {
        html += `>${text}</${tagName}>`;
      } else {
        html += ' />';
      }

      distilledHTML.push(html);

      // Store element metadata
      elementMap.push({
        mcpId,
        tagName,
        text,
        role: role || undefined,
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      });
    });

    return {
      distilledHTML: distilledHTML.join('\n'),
      elementMap,
      totalElements: totalElementsCount,
      visibleElements: elementMap.length,
    };
  }, opts);

  return result;
}

/**
 * Extracts snapshot options from full config.
 *
 * @param config - Full MCP server configuration
 * @returns Snapshot options for DOM optimization
 */
export function getSnapshotOptionsFromConfig(config: Config): SnapshotOptions {
  return config.snapshotOptions || {};
}
