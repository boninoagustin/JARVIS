/**
 * TOON (Token-Oriented Object Notation) Serializer
 * 
 * Compresses homogeneous arrays of objects into a compact tabular format
 * to reduce token consumption when sending structured data to LLMs.
 * 
 * Example:
 *   JSON:  [{"symbol":"BTCUSD","score":8,"signal":"BUY"},{"symbol":"ETHUSD","score":5,"signal":"HOLD"}]
 *   TOON:  data[2]{symbol,score,signal}: BTCUSD,8,BUY | ETHUSD,5,HOLD
 * 
 * Savings: typically 40-60% fewer tokens for tabular data.
 */

const ESCAPE_CHAR = '\\';
const FIELD_SEP = ',';
const ROW_SEP = ' | ';

/**
 * Escapes commas and pipes within a string value so they don't break the format.
 */
function escapeValue(val: string): string {
    return val
        .replace(/\\/g, '\\\\')
        .replace(/,/g, '\\,')
        .replace(/\|/g, '\\|');
}

/**
 * Unescapes a TOON-escaped string value.
 */
function unescapeValue(val: string): string {
    let result = '';
    for (let i = 0; i < val.length; i++) {
        if (val[i] === ESCAPE_CHAR && i + 1 < val.length) {
            result += val[i + 1];
            i++; // skip next char
        } else {
            result += val[i];
        }
    }
    return result;
}

/**
 * Checks if an array contains homogeneous plain objects (same keys).
 */
function isHomogeneousArray(data: any[]): boolean {
    if (data.length === 0) return false;
    if (typeof data[0] !== 'object' || data[0] === null || Array.isArray(data[0])) return false;

    const referenceKeys = Object.keys(data[0]).sort().join(',');
    
    return data.every(item => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
        const itemKeys = Object.keys(item).sort().join(',');
        return itemKeys === referenceKeys;
    });
}

/**
 * Checks if any value in the data contains nested objects/arrays 
 * that would make TOON encoding lossy.
 */
function hasNestedComplexValues(data: any[]): boolean {
    return data.some(item =>
        Object.values(item).some(val =>
            typeof val === 'object' && val !== null
        )
    );
}

/**
 * Serializes a single value to its TOON string representation.
 */
function serializeValue(val: any): string {
    if (val === null || val === undefined) return '_NULL_';
    if (typeof val === 'boolean') return val ? 'T' : 'F';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') return escapeValue(val);
    // Fallback for unexpected types
    return escapeValue(String(val));
}

/**
 * Deserializes a TOON string value back to its JS type.
 */
function deserializeValue(val: string): any {
    if (val === '_NULL_') return null;
    if (val === 'T') return true;
    if (val === 'F') return false;
    
    // Try number
    const num = Number(val);
    if (!isNaN(num) && val.trim() !== '') return num;
    
    return unescapeValue(val);
}

/**
 * Encode an array of homogeneous objects into TOON format.
 * 
 * @param data - Array of objects with the same structure
 * @param label - Optional label for the dataset (default: "data")
 * @returns TOON-encoded string, or JSON fallback for non-homogeneous data
 */
export function toonEncode(data: any[], label: string = 'data'): string {
    // Edge cases
    if (!Array.isArray(data) || data.length === 0) {
        return `${label}[0]{}:`;
    }

    // Fallback to JSON for non-homogeneous or nested-complex data
    if (!isHomogeneousArray(data) || hasNestedComplexValues(data)) {
        return JSON.stringify(data);
    }

    const keys = Object.keys(data[0]);
    const header = `${label}[${data.length}]{${keys.join(FIELD_SEP)}}:`;
    
    const rows = data.map(item => {
        return keys.map(key => serializeValue(item[key])).join(FIELD_SEP);
    });

    return `${header} ${rows.join(ROW_SEP)}`;
}

/**
 * Decode a TOON-encoded string back to an array of objects.
 * 
 * @param toon - TOON-encoded string
 * @returns Array of decoded objects
 */
export function toonDecode(toon: string): any[] {
    // Try JSON fallback first
    try {
        const parsed = JSON.parse(toon);
        if (Array.isArray(parsed)) return parsed;
    } catch {
        // Not JSON, continue with TOON parsing
    }

    // Parse TOON format: label[count]{key1,key2,...}: val1,val2 | val3,val4
    const headerMatch = toon.match(/^(\w+)\[(\d+)\]\{([^}]*)\}:\s*(.*)/s);
    if (!headerMatch) {
        throw new Error(`Invalid TOON format: ${toon.substring(0, 100)}...`);
    }

    const [, , countStr, keysStr, body] = headerMatch;
    const count = parseInt(countStr, 10);

    if (count === 0 || !keysStr) return [];

    const keys = keysStr.split(FIELD_SEP);

    // Split rows by unescaped " | "
    const rows = splitRows(body.trim());

    return rows.map(row => {
        const values = splitFields(row);
        const obj: Record<string, any> = {};
        keys.forEach((key, i) => {
            obj[key] = i < values.length ? deserializeValue(values[i]) : null;
        });
        return obj;
    });
}

/**
 * Split the body into rows by " | " while respecting escaped pipes.
 */
function splitRows(body: string): string[] {
    const rows: string[] = [];
    let current = '';
    let i = 0;
    
    while (i < body.length) {
        if (body[i] === ESCAPE_CHAR && i + 1 < body.length) {
            current += body[i] + body[i + 1];
            i += 2;
            continue;
        }
        if (body.substring(i, i + 3) === ROW_SEP) {
            rows.push(current);
            current = '';
            i += 3;
            continue;
        }
        current += body[i];
        i++;
    }
    if (current) rows.push(current);
    return rows;
}

/**
 * Split a row into fields by "," while respecting escaped commas.
 */
function splitFields(row: string): string[] {
    const fields: string[] = [];
    let current = '';
    let i = 0;
    
    while (i < row.length) {
        if (row[i] === ESCAPE_CHAR && i + 1 < row.length) {
            current += row[i] + row[i + 1];
            i += 2;
            continue;
        }
        if (row[i] === FIELD_SEP) {
            fields.push(current);
            current = '';
            i++;
            continue;
        }
        current += row[i];
        i++;
    }
    if (current) fields.push(current);
    return fields;
}

/**
 * Attempts to compress a tool result string using TOON.
 * Returns the original string if compression isn't beneficial.
 * 
 * @param toolResult - Raw string result from a tool execution
 * @param toolName - Name of the tool (used as TOON label)
 * @returns Object with the (possibly compressed) result and savings info
 */
export function tryCompressToolResult(
    toolResult: string, 
    toolName: string
): { result: string; compressed: boolean; savedBytes: number; savedPercent: number } {
    try {
        const parsed = JSON.parse(toolResult);
        
        if (Array.isArray(parsed) && parsed.length >= 2 && isHomogeneousArray(parsed)) {
            const compressed = toonEncode(parsed, toolName.replace(/[^a-zA-Z0-9_]/g, '_'));
            const savedBytes = toolResult.length - compressed.length;
            const savedPercent = Math.round((savedBytes / toolResult.length) * 100);
            
            // Only use TOON if we actually save space (>10%)
            if (savedPercent > 10) {
                return { result: compressed, compressed: true, savedBytes, savedPercent };
            }
        }
    } catch {
        // Not JSON, can't compress
    }

    return { result: toolResult, compressed: false, savedBytes: 0, savedPercent: 0 };
}
