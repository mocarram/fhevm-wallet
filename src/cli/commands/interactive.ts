/**
 * Interactive CLI mode
 */

import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";
import {
  createWallet,
  importWalletFromMnemonic,
  importWalletFromPrivateKey,
  listWallets,
  removeWallet,
  hasWallet,
  loadWallet,
} from "../../core/wallet/index.js";
import {
  addToken,
  removeToken,
  listTokens,
  getToken,
  TokenEntry,
} from "../../core/token/TokenRegistry.js";
import {
  getDecryptedBalance,
  confidentialTransfer,
  getTxExplorerUrl,
} from "../../core/token/TokenService.js";
import { NetworkName } from "../../core/network/NetworkConfig.js";
import {
  loadConfig,
  updateConfig,
  getDefaultNetwork,
  getDefaultWallet,
  setDefaultWallet,
} from "../../storage/ConfigStore.js";
import {
  formatAddress,
  formatDate,
  formatTokenAmount,
  parseTokenAmount,
  success,
  error,
  warning,
  bold,
} from "../../utils/formatting.js";
import {
  isValidWalletName,
  isValidMnemonic,
  isValidPrivateKey,
  isValidAddress,
  isValidAmount,
  isValidNetwork,
} from "../../utils/validation.js";

type MenuChoice =
  | "wallet"
  | "token"
  | "balance"
  | "send"
  | "config"
  | "exit"
  | "back"
  | "wallet-create"
  | "wallet-import"
  | "wallet-list"
  | "wallet-remove"
  | "wallet-set-default"
  | "token-add"
  | "token-list"
  | "token-remove"
  | "config-show"
  | "config-network"
  | "config-wallet";

function clearScreen(): void {
  console.clear();
}

function printHeader(): void {
  const config = loadConfig();
  const defaultWallet = getDefaultWallet();

  console.log(chalk.cyan.bold("\n  FHE Wallet - Interactive Mode\n"));
  console.log(
    chalk.dim(
      `  Network: ${config.defaultNetwork}  |  Wallet: ${defaultWallet || "(none)"}`,
    ),
  );
  console.log(chalk.dim("  ─".repeat(30)));
  console.log();
}

async function mainMenu(): Promise<MenuChoice> {
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: "What would you like to do?",
      choices: [
        { name: "💰  View Balances", value: "balance" },
        { name: "📤  Send Tokens", value: "send" },
        new inquirer.Separator(),
        { name: "👛  Wallet Management", value: "wallet" },
        { name: "🪙  Token Management", value: "token" },
        { name: "⚙️   Configuration", value: "config" },
        new inquirer.Separator(),
        { name: "🚪  Exit", value: "exit" },
      ],
      loop: false,
    },
  ]);
  return choice;
}

async function walletMenu(): Promise<MenuChoice> {
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: "Wallet Management",
      choices: [
        { name: "➕  Create New Wallet", value: "wallet-create" },
        { name: "📥  Import Wallet", value: "wallet-import" },
        { name: "📋  List Wallets", value: "wallet-list" },
        { name: "⭐  Set Default Wallet", value: "wallet-set-default" },
        { name: "🗑️   Remove Wallet", value: "wallet-remove" },
        new inquirer.Separator(),
        { name: "← Back", value: "back" },
      ],
      loop: false,
    },
  ]);
  return choice;
}

async function tokenMenu(): Promise<MenuChoice> {
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: "Token Management",
      choices: [
        { name: "➕  Add Token", value: "token-add" },
        { name: "📋  List Tokens", value: "token-list" },
        { name: "🗑️   Remove Token", value: "token-remove" },
        new inquirer.Separator(),
        { name: "← Back", value: "back" },
      ],
      loop: false,
    },
  ]);
  return choice;
}

async function configMenu(): Promise<MenuChoice> {
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: "Configuration",
      choices: [
        { name: "👁️   Show Current Config", value: "config-show" },
        { name: "🌐  Change Network", value: "config-network" },
        { name: "👛  Change Default Wallet", value: "config-wallet" },
        new inquirer.Separator(),
        { name: "← Back", value: "back" },
      ],
      loop: false,
    },
  ]);
  return choice;
}

async function handleCreateWallet(): Promise<void> {
  const { name } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Enter wallet name:",
      validate: (input) => {
        if (!isValidWalletName(input)) {
          return "Wallet name must be 1-32 alphanumeric characters, hyphens, or underscores";
        }
        if (hasWallet(input)) {
          return `Wallet "${input}" already exists`;
        }
        return true;
      },
    },
  ]);

  const { password, confirmPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message: "Enter password to encrypt wallet:",
      mask: "*",
      validate: (input) =>
        input.length >= 8 || "Password must be at least 8 characters",
    },
    {
      type: "password",
      name: "confirmPassword",
      message: "Confirm password:",
      mask: "*",
    },
  ]);

  if (password !== confirmPassword) {
    console.log(error("\nPasswords do not match"));
    return;
  }

  const spinner = ora("Creating wallet...").start();
  const result = await createWallet(name, password);
  spinner.succeed("Wallet created");

  console.log();
  console.log(bold("Wallet Details"));
  console.log(`  Name:    ${name}`);
  console.log(`  Address: ${result.address}`);
  console.log();
  console.log(warning("IMPORTANT: Save your recovery phrase securely!"));
  console.log(warning("Anyone with this phrase can access your wallet."));
  console.log();
  console.log(bold("Recovery Phrase:"));
  console.log(chalk.cyan(`  ${result.mnemonic}`));
  console.log();

  const { setAsDefault } = await inquirer.prompt([
    {
      type: "confirm",
      name: "setAsDefault",
      message: "Set as default wallet?",
      default: true,
    },
  ]);

  if (setAsDefault) {
    setDefaultWallet(name);
    console.log(success(`Set "${name}" as default wallet`));
  }
}

async function handleImportWallet(): Promise<void> {
  const { importType } = await inquirer.prompt([
    {
      type: "list",
      name: "importType",
      message: "Import from:",
      choices: [
        { name: "Mnemonic phrase (12 or 24 words)", value: "mnemonic" },
        { name: "Private key", value: "key" },
      ],
    },
  ]);

  const { name } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Enter wallet name:",
      validate: (input) => {
        if (!isValidWalletName(input)) {
          return "Wallet name must be 1-32 alphanumeric characters, hyphens, or underscores";
        }
        if (hasWallet(input)) {
          return `Wallet "${input}" already exists`;
        }
        return true;
      },
    },
  ]);

  let address: string;

  if (importType === "mnemonic") {
    const { mnemonic, password, confirmPassword } = await inquirer.prompt([
      {
        type: "password",
        name: "mnemonic",
        message: "Enter mnemonic phrase:",
        mask: "*",
        validate: (input) =>
          isValidMnemonic(input) || "Invalid mnemonic phrase",
      },
      {
        type: "password",
        name: "password",
        message: "Enter password to encrypt wallet:",
        mask: "*",
        validate: (input) =>
          input.length >= 8 || "Password must be at least 8 characters",
      },
      {
        type: "password",
        name: "confirmPassword",
        message: "Confirm password:",
        mask: "*",
      },
    ]);

    if (password !== confirmPassword) {
      console.log(error("\nPasswords do not match"));
      return;
    }

    const spinner = ora("Importing wallet...").start();
    address = await importWalletFromMnemonic(name, mnemonic, password);
    spinner.succeed("Wallet imported");
  } else {
    const { privateKey, password, confirmPassword } = await inquirer.prompt([
      {
        type: "password",
        name: "privateKey",
        message: "Enter private key:",
        mask: "*",
        validate: (input) => isValidPrivateKey(input) || "Invalid private key",
      },
      {
        type: "password",
        name: "password",
        message: "Enter password to encrypt wallet:",
        mask: "*",
        validate: (input) =>
          input.length >= 8 || "Password must be at least 8 characters",
      },
      {
        type: "password",
        name: "confirmPassword",
        message: "Confirm password:",
        mask: "*",
      },
    ]);

    if (password !== confirmPassword) {
      console.log(error("\nPasswords do not match"));
      return;
    }

    const spinner = ora("Importing wallet...").start();
    address = await importWalletFromPrivateKey(name, privateKey, password);
    spinner.succeed("Wallet imported");
  }

  console.log();
  console.log(bold("Wallet Details"));
  console.log(`  Name:    ${name}`);
  console.log(`  Address: ${address}`);

  const { setAsDefault } = await inquirer.prompt([
    {
      type: "confirm",
      name: "setAsDefault",
      message: "Set as default wallet?",
      default: true,
    },
  ]);

  if (setAsDefault) {
    setDefaultWallet(name);
    console.log(success(`Set "${name}" as default wallet`));
  }
}

async function handleListWallets(): Promise<void> {
  const wallets = listWallets();
  const defaultWallet = getDefaultWallet();

  if (wallets.length === 0) {
    console.log("\nNo wallets found. Create one first.");
    return;
  }

  const table = new Table({
    head: ["Name", "Address", "Created", "Default"],
    style: { head: ["cyan"] },
  });

  for (const w of wallets) {
    const isDefault = w.name === defaultWallet;
    table.push([
      w.name,
      formatAddress(w.address),
      formatDate(w.createdAt),
      isDefault ? chalk.green("*") : "",
    ]);
  }

  console.log();
  console.log(table.toString());
}

async function handleRemoveWallet(): Promise<void> {
  const wallets = listWallets();

  if (wallets.length === 0) {
    console.log("\nNo wallets to remove.");
    return;
  }

  const { walletName, confirm } = await inquirer.prompt([
    {
      type: "list",
      name: "walletName",
      message: "Select wallet to remove:",
      choices: wallets.map((w) => ({
        name: `${w.name} (${formatAddress(w.address)})`,
        value: w.name,
      })),
    },
    {
      type: "confirm",
      name: "confirm",
      message: "Are you sure? This cannot be undone.",
      default: false,
    },
  ]);

  if (!confirm) {
    console.log("Cancelled");
    return;
  }

  const removed = removeWallet(walletName);
  if (removed) {
    console.log(success(`Wallet "${walletName}" removed`));
    if (getDefaultWallet() === walletName) {
      setDefaultWallet("");
    }
  } else {
    console.log(error("Failed to remove wallet"));
  }
}

async function handleSetDefaultWallet(): Promise<void> {
  const wallets = listWallets();

  if (wallets.length === 0) {
    console.log("\nNo wallets available.");
    return;
  }

  const defaultWallet = getDefaultWallet();

  const { walletName } = await inquirer.prompt([
    {
      type: "list",
      name: "walletName",
      message: "Select default wallet:",
      choices: wallets.map((w) => ({
        name: `${w.name} (${formatAddress(w.address)})${w.name === defaultWallet ? " - current" : ""}`,
        value: w.name,
      })),
    },
  ]);

  setDefaultWallet(walletName);
  console.log(success(`Set "${walletName}" as default wallet`));
}

async function handleAddToken(): Promise<void> {
  const network = getDefaultNetwork();

  const { address } = await inquirer.prompt([
    {
      type: "input",
      name: "address",
      message: `Enter token contract address (${network}):`,
      validate: (input) => isValidAddress(input) || "Invalid Ethereum address",
    },
  ]);

  const spinner = ora(`Fetching token info from ${network}...`).start();

  try {
    const entry = await addToken(address, network);
    spinner.succeed("Token added");

    console.log();
    console.log(`  Name:     ${entry.name}`);
    console.log(`  Symbol:   ${entry.symbol}`);
    console.log(`  Decimals: ${entry.decimals}`);
    console.log(`  Address:  ${entry.address}`);
    console.log(`  Network:  ${entry.network}`);
  } catch (err) {
    spinner.fail("Failed to add token");
    console.log(error(err instanceof Error ? err.message : "Unknown error"));
  }
}

async function handleListTokens(): Promise<void> {
  const network = getDefaultNetwork();
  const tokens = listTokens(network);

  if (tokens.length === 0) {
    console.log(`\nNo tokens tracked on ${network}. Add one first.`);
    return;
  }

  const table = new Table({
    head: ["Symbol", "Name", "Address", "Network", "Decimals"],
    style: { head: ["cyan"] },
  });

  for (const t of tokens) {
    table.push([
      t.symbol,
      t.name,
      formatAddress(t.address),
      t.network,
      t.decimals.toString(),
    ]);
  }

  console.log();
  console.log(table.toString());
}

async function handleRemoveToken(): Promise<void> {
  const network = getDefaultNetwork();
  const tokens = listTokens(network);

  if (tokens.length === 0) {
    console.log(`\nNo tokens to remove on ${network}.`);
    return;
  }

  const { tokenAddress, confirm } = await inquirer.prompt([
    {
      type: "list",
      name: "tokenAddress",
      message: "Select token to remove:",
      choices: tokens.map((t) => ({
        name: `${t.symbol} - ${t.name} (${formatAddress(t.address)})`,
        value: t.address,
      })),
    },
    {
      type: "confirm",
      name: "confirm",
      message: "Are you sure?",
      default: false,
    },
  ]);

  if (!confirm) {
    console.log("Cancelled");
    return;
  }

  const removed = removeToken(tokenAddress, network);
  if (removed) {
    console.log(success("Token removed"));
  } else {
    console.log(error("Token not found"));
  }
}

async function handleShowConfig(): Promise<void> {
  const config = loadConfig();
  console.log("\nCurrent configuration:");
  console.log(`  Default network: ${config.defaultNetwork}`);
  console.log(`  Default wallet:  ${config.defaultWallet || "(none)"}`);
}

async function handleChangeNetwork(): Promise<void> {
  const currentNetwork = getDefaultNetwork();

  const { network } = await inquirer.prompt([
    {
      type: "list",
      name: "network",
      message: "Select network:",
      choices: [
        {
          name: `Sepolia (testnet)${currentNetwork === "sepolia" ? " - current" : ""}`,
          value: "sepolia",
        },
        {
          name: `Mainnet${currentNetwork === "mainnet" ? " - current" : ""}`,
          value: "mainnet",
        },
      ],
    },
  ]);

  updateConfig({ defaultNetwork: network as NetworkName });
  console.log(success(`Default network set to ${network}`));
}

async function handleBalance(): Promise<void> {
  const network = getDefaultNetwork();
  const wallets = listWallets();

  if (wallets.length === 0) {
    console.log(error("\nNo wallets found. Create one first."));
    return;
  }

  const tokens = listTokens(network);
  if (tokens.length === 0) {
    console.log(error(`\nNo tokens tracked on ${network}. Add one first.`));
    return;
  }

  const defaultWallet = getDefaultWallet();
  let walletName: string;

  if (wallets.length === 1) {
    walletName = wallets[0].name;
  } else {
    const { selectedWallet } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedWallet",
        message: "Select wallet:",
        choices: wallets.map((w) => ({
          name: `${w.name} (${formatAddress(w.address)})${w.name === defaultWallet ? " - default" : ""}`,
          value: w.name,
        })),
        default: defaultWallet,
      },
    ]);
    walletName = selectedWallet;
  }

  const { password } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message: "Enter wallet password:",
      mask: "*",
    },
  ]);

  const loadSpinner = ora("Decrypting wallet...").start();
  let wallet;
  try {
    wallet = await loadWallet(walletName, password, network);
    loadSpinner.succeed("Wallet loaded");
  } catch (err) {
    loadSpinner.fail("Failed to decrypt wallet");
    console.log(error(err instanceof Error ? err.message : "Invalid password"));
    return;
  }

  console.log();
  console.log(bold(`Balances for ${walletName}`));
  console.log(chalk.dim(`Address: ${wallet.address}`));
  console.log(chalk.dim(`Network: ${network}`));
  console.log();

  const table = new Table({
    head: ["Token", "Balance", "Address"],
    style: { head: ["cyan"] },
  });

  for (const token of tokens) {
    const spinner = ora(`Fetching ${token.symbol} balance...`).start();

    try {
      const balance = await getDecryptedBalance(token.address, wallet, network);
      const formatted = formatTokenAmount(balance, token.decimals);

      spinner.succeed(`${token.symbol}: ${formatted}`);

      table.push([token.symbol, formatted, formatAddress(token.address)]);
    } catch (err) {
      spinner.fail(`${token.symbol}: Failed to fetch`);
      console.log(
        chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`),
      );

      table.push([
        token.symbol,
        chalk.red("Error"),
        formatAddress(token.address),
      ]);
    }
  }

  console.log();
  console.log(table.toString());
}

async function handleSend(): Promise<void> {
  const network = getDefaultNetwork();
  const wallets = listWallets();

  if (wallets.length === 0) {
    console.log(error("\nNo wallets found. Create one first."));
    return;
  }

  const tokens = listTokens(network);
  if (tokens.length === 0) {
    console.log(error(`\nNo tokens tracked on ${network}. Add one first.`));
    return;
  }

  // Select token
  let token: TokenEntry;
  if (tokens.length === 1) {
    token = tokens[0];
    console.log(`\nUsing token: ${token.symbol}`);
  } else {
    const { tokenAddress } = await inquirer.prompt([
      {
        type: "list",
        name: "tokenAddress",
        message: "Select token:",
        choices: tokens.map((t) => ({
          name: `${t.symbol} - ${t.name} (${formatAddress(t.address)})`,
          value: t.address,
        })),
      },
    ]);
    token = getToken(tokenAddress, network)!;
  }

  // Select wallet
  const defaultWallet = getDefaultWallet();
  let walletName: string;

  if (wallets.length === 1) {
    walletName = wallets[0].name;
  } else {
    const { selectedWallet } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedWallet",
        message: "Select wallet:",
        choices: wallets.map((w) => ({
          name: `${w.name} (${formatAddress(w.address)})${w.name === defaultWallet ? " - default" : ""}`,
          value: w.name,
        })),
        default: defaultWallet,
      },
    ]);
    walletName = selectedWallet;
  }

  // Get recipient and amount
  const { to, amount } = await inquirer.prompt([
    {
      type: "input",
      name: "to",
      message: "Enter recipient address:",
      validate: (input) => isValidAddress(input) || "Invalid Ethereum address",
    },
    {
      type: "input",
      name: "amount",
      message: `Enter amount (${token.symbol}):`,
      validate: (input) => isValidAmount(input) || "Invalid amount",
    },
  ]);

  // Get password
  const { password } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message: "Enter wallet password:",
      mask: "*",
    },
  ]);

  // Load wallet
  const loadSpinner = ora("Decrypting wallet...").start();
  let wallet;
  try {
    wallet = await loadWallet(walletName, password, network);
    loadSpinner.succeed("Wallet loaded");
  } catch (err) {
    loadSpinner.fail("Failed to decrypt wallet");
    console.log(error(err instanceof Error ? err.message : "Invalid password"));
    return;
  }

  // Parse amount
  const amountBigInt = parseTokenAmount(amount, token.decimals);

  // Confirm transaction
  console.log();
  console.log(bold("Transaction Summary"));
  console.log(`  From:    ${wallet.address}`);
  console.log(`  To:      ${to}`);
  console.log(`  Amount:  ${amount} ${token.symbol}`);
  console.log(`  Token:   ${token.name}`);
  console.log(`  Network: ${network}`);
  console.log();

  const { confirm } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirm",
      message: "Confirm transaction?",
      default: false,
    },
  ]);

  if (!confirm) {
    console.log("Transaction cancelled");
    return;
  }

  // Execute transfer
  console.log();
  const encryptSpinner = ora("Encrypting amount...").start();

  try {
    encryptSpinner.text = "Sending transaction...";

    const result = await confidentialTransfer(
      wallet,
      token.address,
      to,
      amountBigInt,
      network,
    );

    encryptSpinner.succeed("Transaction sent");

    console.log();
    console.log(success("Transfer successful!"));
    console.log(`  Transaction: ${result.txHash}`);
    console.log(`  Explorer:    ${getTxExplorerUrl(result.txHash, network)}`);
    console.log();

    if (result.receipt.status === 1) {
      console.log(chalk.green("Transaction confirmed"));
    } else {
      console.log(chalk.red("Transaction may have failed"));
    }
  } catch (err) {
    encryptSpinner.fail("Transaction failed");
    console.log(error(err instanceof Error ? err.message : "Unknown error"));
  }
}

async function waitForKey(): Promise<void> {
  await inquirer.prompt([
    {
      type: "input",
      name: "continue",
      message: chalk.dim("Press Enter to continue..."),
    },
  ]);
}

async function runInteractiveMode(): Promise<void> {
  let running = true;

  while (running) {
    clearScreen();
    printHeader();

    const choice = await mainMenu();

    switch (choice) {
      case "wallet": {
        let inWalletMenu = true;
        while (inWalletMenu) {
          clearScreen();
          printHeader();
          const walletChoice = await walletMenu();

          switch (walletChoice) {
            case "wallet-create":
              await handleCreateWallet();
              await waitForKey();
              break;
            case "wallet-import":
              await handleImportWallet();
              await waitForKey();
              break;
            case "wallet-list":
              await handleListWallets();
              await waitForKey();
              break;
            case "wallet-remove":
              await handleRemoveWallet();
              await waitForKey();
              break;
            case "wallet-set-default":
              await handleSetDefaultWallet();
              await waitForKey();
              break;
            case "back":
              inWalletMenu = false;
              break;
          }
        }
        break;
      }

      case "token": {
        let inTokenMenu = true;
        while (inTokenMenu) {
          clearScreen();
          printHeader();
          const tokenChoice = await tokenMenu();

          switch (tokenChoice) {
            case "token-add":
              await handleAddToken();
              await waitForKey();
              break;
            case "token-list":
              await handleListTokens();
              await waitForKey();
              break;
            case "token-remove":
              await handleRemoveToken();
              await waitForKey();
              break;
            case "back":
              inTokenMenu = false;
              break;
          }
        }
        break;
      }

      case "config": {
        let inConfigMenu = true;
        while (inConfigMenu) {
          clearScreen();
          printHeader();
          const configChoice = await configMenu();

          switch (configChoice) {
            case "config-show":
              await handleShowConfig();
              await waitForKey();
              break;
            case "config-network":
              await handleChangeNetwork();
              await waitForKey();
              break;
            case "config-wallet":
              await handleSetDefaultWallet();
              await waitForKey();
              break;
            case "back":
              inConfigMenu = false;
              break;
          }
        }
        break;
      }

      case "balance":
        await handleBalance();
        await waitForKey();
        break;

      case "send":
        await handleSend();
        await waitForKey();
        break;

      case "exit":
        running = false;
        clearScreen();
        console.log(chalk.cyan("\nGoodbye!\n"));
        break;
    }
  }
}

export function registerInteractiveCommand(program: Command): void {
  program
    .command("interactive")
    .alias("i")
    .description("Launch interactive mode")
    .action(async () => {
      await runInteractiveMode();
    });
}

export { runInteractiveMode };
