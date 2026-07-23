import re

with open('src/engine/PortfolioModel.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = "const TTL = 5 * 60 * 1000;"
replacement1 = """const TTL = 30 * 1000; // 30s: suficiente anti-estampida, mínima ventana de bypass

export function invalidateRiskCache(prefix?: string): void {
    for (const key of riskCache.keys()) {
        if (!prefix || key.startsWith(prefix)) riskCache.delete(key);
    }
}"""
content = content.replace(target1, replacement1)

with open('src/engine/PortfolioModel.ts', 'w', encoding='utf-8') as f:
    f.write(content)

