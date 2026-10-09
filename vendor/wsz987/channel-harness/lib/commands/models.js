/**
 * The `/models` command (spec §15–§17).
 *
 * Model DISCOVERY only: reads the Harness LLM adapter registry through the
 * official `deps.llm` catalog seam (listProviders / listModels) — the channel never
 * touches provider HTTP endpoints and never treats the catalog as
 * authoritative. Catalog membership is ADVISORY (spec §17): it is used for
 * display only; `/model` performs exact resolution separately. A provider
 * whose model listing fails must not fail the whole command (spec §15).
 */
import {} from '@deepseek-ai/dsh-commands';
export function createModelsCommand(deps) {
    return {
        name: 'models',
        description: 'List registered model providers and their models',
        input: { hint: '[provider]' },
        async handler(invocation) {
            const llm = deps.llm;
            const providers = llm.listProviders();
            const filter = invocation.rawInput.trim();
            if (filter.length > 0) {
                const provider = providers.find((p) => p.id === filter);
                if (!provider) {
                    return {
                        kind: 'error',
                        text: '未找到 Provider: ' + filter + availableSuffix(providers),
                    };
                }
                return { kind: 'success', text: (await buildProviderLines(llm, provider)).join('\n') };
            }
            if (providers.length === 0) {
                return { kind: 'success', text: '当前没有已注册的模型 Provider。' };
            }
            const sections = await Promise.all(providers.map((p) => buildProviderLines(llm, p)));
            const lines = [];
            for (const section of sections) {
                if (lines.length > 0)
                    lines.push('');
                lines.push(...section);
            }
            return { kind: 'success', text: lines.join('\n') };
        },
    };
}
function availableSuffix(providers) {
    if (providers.length === 0)
        return '';
    return '\n\n可用：\n' + providers.map((p) => p.id).join('\n');
}
async function buildProviderLines(llm, provider) {
    const lines = [provider.name + ' (' + provider.id + ')'];
    try {
        const models = await llm.listModels(provider.id);
        if (models.length === 0) {
            lines.push('- (无模型)');
        }
        else {
            for (const model of models)
                lines.push('- ' + model.id);
        }
    }
    catch {
        lines.push('- 模型目录获取失败');
    }
    return lines;
}
//# sourceMappingURL=models.js.map