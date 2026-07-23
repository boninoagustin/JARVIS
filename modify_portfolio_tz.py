import re

with open('src/engine/PortfolioModel.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """function getArgentinaMidnightMs(nowMs: number): number {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
    const [year, month, day] = formatter.format(new Date(nowMs)).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 3, 0, 0)).getTime();
}"""

replacement1 = """const BA_TZ = 'America/Argentina/Buenos_Aires';

function getArgentinaMidnightMs(nowMs: number): number {
    const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BA_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const [year, month, day] = dayFmt.format(new Date(nowMs)).split('-').map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const offsetMs = new Date(probe.toLocaleString('en-US', { timeZone: BA_TZ })).getTime() - probe.getTime();
    return Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMs;
}"""
content = content.replace(target1, replacement1)

target2 = """            const endOfDayMs = artMidnightMs + 24 * 60 * 60 * 1000 - 1000;"""
replacement2 = """            const endOfDayMs = getArgentinaMidnightMs(artMidnightMs + 30 * 60 * 60 * 1000) - 1000;"""
content = content.replace(target2, replacement2)

with open('src/engine/PortfolioModel.ts', 'w', encoding='utf-8') as f:
    f.write(content)

