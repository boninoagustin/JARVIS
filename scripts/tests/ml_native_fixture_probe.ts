// Isolated numeric fixture probe: no trading imports or active registry installation.
import {readFileSync} from 'node:fs';
import {validateModel,predictNativeVector,NATIVE_INFERENCE_PROFILE} from '../../src/engine/MLModelValidation.js';
import {REGIME_FEATURE_NAMES} from '../../src/engine/MLRegimeFeatures.js';
const input=JSON.parse(readFileSync(0,'utf8'));
const model=validateModel(input.model,REGIME_FEATURE_NAMES,NATIVE_INFERENCE_PROFILE);
console.log(JSON.stringify(input.rows.map((row:(number|null)[])=>predictNativeVector(model,row.map(v=>v===null?NaN:v)))));
