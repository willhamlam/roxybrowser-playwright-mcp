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

    // Find all potentially interactive elements
    const elements = document.querySelectorAll(interactiveSelectors.join(','));

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

        // Viewport intersection with buffer (browser-use approach)
        const absoluteTop = rect.top + scrollY;
        const absoluteBottom = rect.bottom + scrollY;
        const viewportTop = scrollY - viewportBuffer;
        const viewportBottom = scrollY + viewportHeight + viewportBuffer;

        if (absoluteBottom < viewportTop || absoluteTop > viewportBottom) {
          return;
        }
      }

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
      totalElements: elements.length,
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
