import re

with open('src/engine/StateStore.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target_import = "import type { ActiveTrade, RadarState, AssetSessionConfig, GlobalPortfolioConfig } from './Types.js';"
replacement_import = """import { z } from 'zod';
import type { ActiveTrade, RadarState, AssetSessionConfig, GlobalPortfolioConfig } from './Types.js';
import { AssetSessionConfigSchema } from './Types.js';

type EntryTrigger = NonNullable<z.infer<typeof AssetSessionConfigSchema>['entryTrigger']>;"""
content = content.replace(target_import, replacement_import)

target_trigger = "entryTrigger: 'OTE' as 'CHOCH' | 'OTE' | 'BOTH' | 'SMART',"
replacement_trigger = "entryTrigger: 'OTE' as EntryTrigger,"
content = content.replace(target_trigger, replacement_trigger)

with open('src/engine/StateStore.ts', 'w', encoding='utf-8') as f:
    f.write(content)
