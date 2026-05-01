#!/usr/bin/env node
import 'dotenv/config';
import { operationalBalances } from '../src/balances.js';

console.log(JSON.stringify(await operationalBalances(), null, 2));
