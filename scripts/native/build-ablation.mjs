import {resolve} from 'node:path';
import {buildNativeContract} from '../build-native-counter.mjs';
process.env.ALKANES_NATIVE_ABLATE_COERCION='1';
buildNativeContract({work:resolve('build/scriptc-native/generic-coercion'),out:resolve('build/scriptc-native/reference/counter-native-generic-coercion.wasm')});
