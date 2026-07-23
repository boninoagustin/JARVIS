import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """    let triggerOte = false;
    let oteData: any = null;

    try {"""
replacement1 = """    let triggerOte = false;
    let oteData: any = null;
    let dispatchData: any = null;

    try {"""
content = content.replace(target1, replacement1)

target2 = """        }

        let dispatchData: any = null;
        if (triggerOte && oteData) {"""
replacement2 = """        }

        if (triggerOte && oteData) {"""
content = content.replace(target2, replacement2)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
