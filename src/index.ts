#!/usr/bin/env node

/**
 * FHE Wallet CLI - Entry Point
 *
 * A CLI wallet for managing encrypted ERC-7984 tokens using Zama's FHE technology.
 */

import 'dotenv/config';
import { createProgram } from './cli/index.js';

const program = createProgram();

program.parse(process.argv);
