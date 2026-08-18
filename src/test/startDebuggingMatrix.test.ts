// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebugState } from '../debugState';
import { DebuggingHandler } from '../debuggingHandler';
import { IDebuggingExecutor, TestDebugDispatch } from '../debuggingExecutor';
import { IDebugConfigurationManager } from '../utils/debugConfigurationManager';

/**
 * Regression matrix for handleStartDebugging.
 *
 * The handler returns as soon as the start command is dispatched
 * (asynchronous launch); it no longer blocks on session readiness, a
 * breakpoint hit, or a timeout. This matrix verifies:
 *   1. launch success — returns immediately with a "start command issued"
 *      message (no wait, no readiness state).
 *   2. launch failure — startDebugging returned false → error surfaced.
 *   3. config failure — getDebugConfig threw (e.g. missing built assembly)
 *      → error surfaced.
 *
 * Both the "launch" path (no testName) and the "test" path (testName +
 * Testing API) are exercised. Post-launch monitoring is the responsibility
 * of get_debug_state and the Debug Console.
 */

interface MockOpts {
    startResult?: boolean | Error;
    testDispatch?: TestDebugDispatch | Error;
    debugConfig?: string | vscode.DebugConfiguration | Error;
    language?: string;
    activeSession?: boolean;
}

function makeMocks(opts: MockOpts) {
    const state = new DebugState();
    state.sessionActive = false;

    const executor: IDebuggingExecutor = {
        startDebugging: async () => {
            if (opts.startResult instanceof Error) {
                throw opts.startResult;
            }
            return opts.startResult ?? true;
        },
        debugTestAtCursor: async () => {
            if (opts.testDispatch instanceof Error) {
                throw opts.testDispatch;
            }
            // Default: never resolves runComplete unless caller provides one.
            return opts.testDispatch ?? { started: true, runComplete: new Promise<void>(() => { /* pending */ }) };
        },
        waitForDebugSessionReady: () => Promise.resolve('no-session' as const),
        getCurrentDebugState: async () => state,
        stopDebugging: async () => { /* noop */ },
        stepOver: async () => { /* noop */ },
        stepInto: async () => { /* noop */ },
        stepOut: async () => { /* noop */ },
        continue: async () => { /* noop */ },
        pause: async () => { /* noop */ },
        restart: async () => { /* noop */ },
        addBreakpoint: async () => { /* noop */ },
        removeBreakpoint: async () => { /* noop */ },
        getVariables: async () => ({}),
        evaluateExpression: async () => ({}),
        getBreakpoints: () => [],
        clearAllBreakpoints: () => { /* noop */ },
        hasActiveSession: async () => opts.activeSession ?? false,
        getActiveSession: () => undefined
    };

    const configManager: IDebugConfigurationManager = {
        getDebugConfig: async () => {
            if (opts.debugConfig instanceof Error) {
                throw opts.debugConfig;
            }
            return opts.debugConfig ?? {
                type: opts.language ?? 'python',
                request: 'launch',
                name: 'DebugMCP Launch',
                program: 'unused'
            };
        },
        detectLanguageFromFilePath: () => opts.language ?? 'python',
        getAvailableDebugTargets: async () => []
    };

    return { executor, configManager };
}

interface LangCase {
    label: string;
    file: string;
    debuggerType: string;
}

const LANGUAGES: LangCase[] = [
    { label: 'Python',     file: '/repo/src/app.py',          debuggerType: 'python'   },
    { label: 'JavaScript', file: '/repo/src/app.js',          debuggerType: 'pwa-node' },
    { label: 'TypeScript', file: '/repo/src/app.ts',          debuggerType: 'pwa-node' },
    { label: 'Java',       file: '/repo/src/App.java',        debuggerType: 'java'     },
    { label: 'C#',         file: '/repo/src/AppTests.cs',     debuggerType: 'coreclr'  },
    { label: 'C++',        file: '/repo/src/app.cpp',         debuggerType: 'cppdbg'   },
    { label: 'Go',         file: '/repo/src/main.go',         debuggerType: 'go'       }
];

suite('handleStartDebugging regression matrix', () => {

    // -------------------------------------------------------------------------
    // Launch path (no testName) — uses executor.startDebugging and returns
    // immediately with an "async launch" message.
    // -------------------------------------------------------------------------
    for (const lang of LANGUAGES) {

        test(`[${lang.label}] launch path: returns immediately with start command issued`, async () => {
            const { executor, configManager } = makeMocks({
                startResult: true,
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            const result = await handler.handleStartDebugging({
                fileFullPath: lang.file,
                workingDirectory: '/repo'
            });

            assert.match(result, /start command issued/);
            assert.match(result, new RegExp(escapeRegex(lang.file)));
            assert.match(result, /asynchronously/);
        });

        test(`[${lang.label}] launch path: launch-error surfaces failure`, async () => {
            const { executor, configManager } = makeMocks({
                startResult: false,
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            await assert.rejects(
                handler.handleStartDebugging({
                    fileFullPath: lang.file,
                    workingDirectory: '/repo'
                }),
                /Failed to start debug session/
            );
        });
    }

    // -------------------------------------------------------------------------
    // Duplicate-launch guard: refuse to start while a session is already active.
    // -------------------------------------------------------------------------
    test('[Python] launch path: rejects when a debug session is already active', async () => {
        const { executor, configManager } = makeMocks({
            startResult: true,
            activeSession: true,
            language: 'python'
        });
        const handler = new DebuggingHandler(executor, configManager, 30);

        await assert.rejects(
            handler.handleStartDebugging({
                fileFullPath: '/repo/src/app.py',
                workingDirectory: '/repo'
            }),
            /already active.*stop_debugging/i
        );
    });

    // -------------------------------------------------------------------------
    // No-build / config-resolution failure (most relevant to .NET coreclr,
    // but the handler must surface it uniformly for any language).
    // -------------------------------------------------------------------------
    test('[C#] launch path: no-build surfaces config error', async () => {
        const { executor, configManager } = makeMocks({
            debugConfig: new Error("Could not find a built assembly for App.csproj. Run 'dotnet build' first"),
            language: 'coreclr'
        });
        const handler = new DebuggingHandler(executor, configManager, 30);

        await assert.rejects(
            handler.handleStartDebugging({
                fileFullPath: '/repo/src/App.cs',
                workingDirectory: '/repo'
            }),
            /Could not find a built assembly/
        );
    });

    // -------------------------------------------------------------------------
    // Test path (testName) — dispatches via the Testing API, then returns
    // immediately; does not race runComplete against session readiness.
    // -------------------------------------------------------------------------
    for (const lang of LANGUAGES) {

        test(`[${lang.label}] test path: returns immediately after dispatching test`, async () => {
            const { executor, configManager } = makeMocks({
                testDispatch: { started: true, runComplete: new Promise<void>(() => { /* pending */ }) },
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            const result = await handler.handleStartDebugging({
                fileFullPath: lang.file,
                workingDirectory: '/repo',
                testName: 'My_Test'
            });

            assert.match(result, /start command issued/);
            assert.match(result, /test: My_Test/);
        });

        test(`[${lang.label}] test path: launch-error surfaces failure`, async () => {
            const { executor, configManager } = makeMocks({
                testDispatch: new Error(`Could not locate test 'My_Test' in ${lang.file}`),
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            await assert.rejects(
                handler.handleStartDebugging({
                    fileFullPath: lang.file,
                    workingDirectory: '/repo',
                    testName: 'My_Test'
                }),
                /Could not locate test/
            );
        });
    }
});

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
