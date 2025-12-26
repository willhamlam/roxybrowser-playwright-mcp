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

import { z } from 'zod';
import * as playwright from 'playwright';

import { defineTabTool, defineTool } from './tool.js';
import * as javascript from '../utils/codegen.js';
import { generateLocator } from './utils.js';

const snapshot = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description: 'Capture accessibility snapshot of the current page, this is better than screenshot',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    response.setIncludeSnapshot();
  },
});

export const elementSchema = z.object({
  element: z.string().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().optional().describe('Exact target element reference from the page snapshot (used in ARIA mode)'),
  mcpId: z.number().optional().describe('Element ID from optimized snapshot (used in optimized mode, alternative to ref)'),
});

const clickSchema = elementSchema.extend({
  doubleClick: z.boolean().optional().describe('Whether to perform a double click instead of a single click'),
  button: z.enum(['left', 'right', 'middle']).optional().describe('Button to click, defaults to left'),
});

const click = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_click',
    title: 'Click',
    description: 'Perform click on a web page',
    inputSchema: clickSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    let locator: playwright.Locator;

    // Optimized mode - use mcpId
    if (params.mcpId !== undefined) {
      locator = await tab.getElementByMcpId(params.mcpId);
      const button = params.button;
      const buttonAttr = button ? `{ button: '${button}' }` : '';
      if (params.doubleClick)
        response.addCode(`await page.locator('[data-mcp-id="${params.mcpId}"]').dblclick(${buttonAttr});`);
      else
        response.addCode(`await page.locator('[data-mcp-id="${params.mcpId}"]').click(${buttonAttr});`);
    }
    // Legacy mode - use ref
    else if (params.ref) {
      locator = await tab.refLocator({ element: params.element, ref: params.ref });
      const button = params.button;
      const buttonAttr = button ? `{ button: '${button}' }` : '';
      if (params.doubleClick)
        response.addCode(`await page.${await generateLocator(locator)}.dblclick(${buttonAttr});`);
      else
        response.addCode(`await page.${await generateLocator(locator)}.click(${buttonAttr});`);
    }
    else {
      throw new Error('Either ref or mcpId must be provided');
    }

    const button = params.button;
    await tab.waitForCompletion(async () => {
      if (params.doubleClick)
        await locator.dblclick({ button });
      else
        await locator.click({ button });
    });
  },
});

const drag = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_drag',
    title: 'Drag mouse',
    description: 'Perform drag and drop between two elements',
    inputSchema: z.object({
      startElement: z.string().describe('Human-readable source element description used to obtain the permission to interact with the element'),
      startRef: z.string().optional().describe('Exact source element reference from the page snapshot (ARIA mode)'),
      startMcpId: z.number().optional().describe('Source element ID from optimized snapshot (alternative to startRef)'),
      endElement: z.string().describe('Human-readable target element description used to obtain the permission to interact with the element'),
      endRef: z.string().optional().describe('Exact target element reference from the page snapshot (ARIA mode)'),
      endMcpId: z.number().optional().describe('Target element ID from optimized snapshot (alternative to endRef)'),
    }),
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    let startLocator: playwright.Locator;
    let endLocator: playwright.Locator;

    // Optimized mode - use mcpIds
    if (params.startMcpId !== undefined && params.endMcpId !== undefined) {
      startLocator = await tab.getElementByMcpId(params.startMcpId);
      endLocator = await tab.getElementByMcpId(params.endMcpId);
      response.addCode(`await page.locator('[data-mcp-id="${params.startMcpId}"]').dragTo(page.locator('[data-mcp-id="${params.endMcpId}"]'));`);
    }
    // Legacy mode - use refs
    else if (params.startRef && params.endRef) {
      [startLocator, endLocator] = await tab.refLocators([
        { ref: params.startRef, element: params.startElement },
        { ref: params.endRef, element: params.endElement },
      ]);
      response.addCode(`await page.${await generateLocator(startLocator)}.dragTo(page.${await generateLocator(endLocator)});`);
    }
    else {
      throw new Error('Either both refs or both mcpIds must be provided');
    }

    await tab.waitForCompletion(async () => {
      await startLocator.dragTo(endLocator);
    });
  },
});

const hover = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_hover',
    title: 'Hover mouse',
    description: 'Hover over element on page',
    inputSchema: elementSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    let locator: playwright.Locator;

    // Optimized mode - use mcpId
    if (params.mcpId !== undefined) {
      locator = await tab.getElementByMcpId(params.mcpId);
      response.addCode(`await page.locator('[data-mcp-id="${params.mcpId}"]').hover();`);
    }
    // Legacy mode - use ref
    else if (params.ref) {
      locator = await tab.refLocator({ element: params.element, ref: params.ref });
      response.addCode(`await page.${await generateLocator(locator)}.hover();`);
    }
    else {
      throw new Error('Either ref or mcpId must be provided');
    }

    await tab.waitForCompletion(async () => {
      await locator.hover();
    });
  },
});

const selectOptionSchema = elementSchema.extend({
  values: z.array(z.string()).describe('Array of values to select in the dropdown. This can be a single value or multiple values.'),
});

const selectOption = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_select_option',
    title: 'Select option',
    description: 'Select an option in a dropdown',
    inputSchema: selectOptionSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    let locator: playwright.Locator;

    // Optimized mode - use mcpId
    if (params.mcpId !== undefined) {
      locator = await tab.getElementByMcpId(params.mcpId);
      response.addCode(`await page.locator('[data-mcp-id="${params.mcpId}"]').selectOption(${javascript.formatObject(params.values)});`);
    }
    // Legacy mode - use ref
    else if (params.ref) {
      locator = await tab.refLocator({ element: params.element, ref: params.ref });
      response.addCode(`await page.${await generateLocator(locator)}.selectOption(${javascript.formatObject(params.values)});`);
    }
    else {
      throw new Error('Either ref or mcpId must be provided');
    }

    await tab.waitForCompletion(async () => {
      await locator.selectOption(params.values);
    });
  },
});

export default [
  snapshot,
  click,
  drag,
  hover,
  selectOption,
];
