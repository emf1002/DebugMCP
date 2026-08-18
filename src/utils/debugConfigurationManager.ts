// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * A target that `start_debugging` can launch, mirroring what the "Run and
 * Debug" dropdown in VS Code would offer for the current workspace:
 * - `workspace`: configurations from the workspace-level launch settings —
 *   a single-root `.vscode/launch.json`, or the `launch` section of a
 *   multi-root `.code-workspace` file.
 * - `folder`: configurations from a specific workspace folder's
 *   `.vscode/launch.json` (multi-root workspaces only).
 * - `default`: DebugMCP's auto-launch, which picks a debugger type from the
 *   source file's extension.
 */
export interface DebugTargetInfo {
    name: string;
    source: 'workspace' | 'folder' | 'default';
    debuggerTypes?: string[];
}

/**
 * Interface for configuration management operations
 */
export interface IDebugConfigurationManager {
    getDebugConfig(
        workingDirectory: string,
        fileFullPath: string,
        configurationName?: string
    ): Promise<string | vscode.DebugConfiguration>;
    detectLanguageFromFilePath(fileFullPath: string): string;
    getAvailableDebugTargets(): Promise<DebugTargetInfo[]>;
}

/**
 * Responsible for producing the argument passed to vscode.debug.startDebugging()
 * for *non-test* launches.
 *
 * We deliberately keep configurations minimal and rely on:
 *  - VS Code's own launch.json resolution (when the caller passes a config name)
 *  - The language extension's DebugConfigurationProvider.resolveDebugConfiguration
 *    (which fills in cwd, console, env, and other defaults for ad-hoc launches)
 *
 * Test launches go through DebuggingExecutor.debugTestAtCursor instead — VS Code's
 * Testing API knows how to debug a specific test for any language whose extension
 * registers a TestController, including the parent/child process handoff that
 * `dotnet test` requires.
 */
export class DebugConfigurationManager implements IDebugConfigurationManager {
    private static readonly AUTO_LAUNCH_CONFIG = 'Default Configuration';

    private static readonly LANGUAGE_MAP: { [key: string]: string } = {
        '.py': 'python',
        '.js': 'pwa-node',
        '.ts': 'pwa-node',
        '.jsx': 'pwa-node',
        '.tsx': 'pwa-node',
        '.java': 'java',
        '.cs': 'coreclr',
        '.csproj': 'coreclr',
        '.cpp': 'cppdbg',
        '.cc': 'cppdbg',
        '.c': 'cppdbg',
        '.go': 'go',
        '.rs': 'lldb',
        '.php': 'php',
        '.rb': 'ruby'
    };

    /**
     * Returns either a launch.json configuration name (string) or a minimal
     * DebugConfiguration stub. Both forms are accepted by
     * vscode.debug.startDebugging(folder, nameOrConfiguration).
     */
    public async getDebugConfig(
        workingDirectory: string,
        fileFullPath: string,
        configurationName?: string
    ): Promise<string | vscode.DebugConfiguration> {
        // Named launch config — resolve from workspace-level (.code-workspace) first.
        if (configurationName &&
            configurationName.trim() !== '' &&
            configurationName !== DebugConfigurationManager.AUTO_LAUNCH_CONFIG) {
            // Multi-root workspaces can define configurations in the `.code-workspace`
            // file's `launch` section. VS Code only resolves a config *by name* against
            // the folder passed to startDebugging, so a workspace-level config would be
            // missed. Hand back the resolved object in that case.
            const workspaceConfig = vscode.workspace.getConfiguration('launch');
            const configurations = workspaceConfig.get<vscode.DebugConfiguration[]>('configurations') ?? [];
            const match = configurations.find(c => c && c.name === configurationName);
            if (match) {
                return { ...match };
            }
            // Folder-level launch.json / dynamic provider config — let VS Code resolve it itself.
            return configurationName;
        }

        const language = this.detectLanguageFromFilePath(fileFullPath);

        // .NET needs the compiled assembly, not the .cs source file.
        if (language === 'coreclr') {
            return await this.createDotNetLaunchConfig(fileFullPath);
        }

        // Minimal stub. The language extension's resolveDebugConfiguration
        // fills in cwd, console, env, stopOnEntry, and other defaults.
        return {
            type: language,
            request: 'launch',
            name: 'DebugMCP Launch',
            program: fileFullPath
        };
    }

    public static getAutoLaunchConfigName(): string {
        return DebugConfigurationManager.AUTO_LAUNCH_CONFIG;
    }

    /**
     * Walk up from `startPath` to find the nearest `*.csproj` file.
     * Stops at the filesystem root.
     */
    private async findNearestCsproj(startPath: string): Promise<string | null> {
        let dir = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
        while (true) {
            try {
                const entries = await fs.promises.readdir(dir);
                const csproj = entries.find(e => e.toLowerCase().endsWith('.csproj'));
                if (csproj) {
                    return path.join(dir, csproj);
                }
            } catch {
                // ignore unreadable directories
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                return null;
            }
            dir = parent;
        }
    }

    /**
     * Locate the built assembly for a .csproj. Looks under
     * `<projectDir>/bin/{Debug,Release}/<tfm>/<AssemblyName>.dll` and prefers
     * the most recently modified match.
     */
    private async findBuiltAssembly(csprojPath: string): Promise<string | null> {
        const projectDir = path.dirname(csprojPath);
        const assemblyName = path.basename(csprojPath, '.csproj');
        const candidates: { file: string; mtime: number }[] = [];

        for (const config of ['Debug', 'Release']) {
            const binDir = path.join(projectDir, 'bin', config);
            if (!fs.existsSync(binDir)) {
                continue;
            }
            for (const tfm of await fs.promises.readdir(binDir)) {
                const dll = path.join(binDir, tfm, `${assemblyName}.dll`);
                try {
                    const stat = await fs.promises.stat(dll);
                    if (stat.isFile()) {
                        candidates.push({ file: dll, mtime: stat.mtimeMs });
                    }
                } catch {
                    // missing — try next tfm
                }
            }
        }

        if (candidates.length === 0) {
            return null;
        }
        candidates.sort((a, b) => b.mtime - a.mtime);
        return candidates[0].file;
    }

    /**
     * Build a coreclr launch config pointing at the project's built DLL.
     * Throws a clear error if the project hasn't been built yet.
     */
    private async createDotNetLaunchConfig(fileFullPath: string): Promise<vscode.DebugConfiguration> {
        const csproj = await this.findNearestCsproj(fileFullPath);
        if (!csproj) {
            throw new Error(
                `Could not locate a .csproj for ${fileFullPath}. ` +
                `Pass a launch.json configurationName, or place the file inside a .NET project.`
            );
        }

        const assembly = await this.findBuiltAssembly(csproj);
        if (!assembly) {
            throw new Error(
                `Could not find a built assembly for ${path.basename(csproj)}. ` +
                `Run 'dotnet build' first, or pass a launch.json configurationName.`
            );
        }

        return {
            type: 'coreclr',
            request: 'launch',
            name: 'DebugMCP .NET Launch',
            program: assembly,
            cwd: path.dirname(csproj),
            stopAtEntry: false
        };
    }

    /**
     * Detect debugger type from file extension.
     */
    public detectLanguageFromFilePath(fileFullPath: string): string {
        const extension = path.extname(fileFullPath).toLowerCase();
        return DebugConfigurationManager.LANGUAGE_MAP[extension] || 'python';
    }

    /**
     * List the debug targets the "Run and Debug" dropdown would offer for the
     * current workspace.
     *
     * Uses `workspace.getConfiguration('launch')` rather than parsing launch.json
     * files directly, so it automatically covers both single-root `.vscode/launch.json`
     * and the `launch` section of a multi-root `.code-workspace` file. In multi-root
     * workspaces we also enumerate each folder's own launch.json. A synthetic
     * `default` entry advertises DebugMCP's extension-based auto-launch.
     */
    public async getAvailableDebugTargets(): Promise<DebugTargetInfo[]> {
        const targets: DebugTargetInfo[] = [];
        const seen = new Set<string>();

        const collect = (config: vscode.WorkspaceConfiguration, source: DebugTargetInfo['source']): void => {
            const configurations = config.get<{ name?: string }[]>('configurations') || [];
            for (const c of configurations) {
                if (c && typeof c.name === 'string' && c.name.trim() && !seen.has(c.name.trim())) {
                    seen.add(c.name.trim());
                    targets.push({ name: c.name.trim(), source });
                }
            }
        };

        // Workspace-level: single-root launch.json, or the .code-workspace `launch` section.
        collect(vscode.workspace.getConfiguration('launch'), 'workspace');

        // Multi-root: each folder's own .vscode/launch.json.
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            collect(vscode.workspace.getConfiguration('launch', folder.uri), 'folder');
        }

        targets.push({
            name: DebugConfigurationManager.AUTO_LAUNCH_CONFIG,
            source: 'default',
            debuggerTypes: [...new Set(Object.values(DebugConfigurationManager.LANGUAGE_MAP))],
        });

        return targets;
    }
}
