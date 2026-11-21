/**
 * Every screen by id. The router (state.stack) holds ids; this maps them to modules.
 */

import type { ScreenDef } from '../screen.js';
import { balancesScreen, unlockScreen } from './balances.js';
import {
  contactAddressScreen,
  contactNameScreen,
  contactRemoveConfirmScreen,
  contactRemoveScreen,
  contactsScreen,
} from './contacts.js';
import { doctorScreen } from './doctor.js';
import { historyScreen } from './history.js';
import { homeScreen } from './home.js';
import { receiveScreen } from './receive.js';
import {
  sendAmountScreen,
  sendCheckScreen,
  sendCountScreen,
  sendErrorScreen,
  sendPasteScreen,
  sendRetypeScreen,
  sendReviewScreen,
  sendSignScreen,
  sendTokenScreen,
  sendToScreen,
} from './send.js';
import {
  settingsKeyScreen,
  settingsNetworkScreen,
  settingsRpcScreen,
  settingsRpcUrlScreen,
  settingsScreen,
} from './settings.js';
import {
  setupGasScreen,
  setupNetworkScreen,
  setupTokenScreen,
  setupWelcomeScreen,
} from './setup.js';
import {
  tokenAddConfirmScreen,
  tokenAddScreen,
  tokenFindScreen,
  tokenRemoveScreen,
  tokensScreen,
} from './tokens.js';
import { txCountScreen, txReviewScreen, txSignScreen } from './tx.js';
import {
  operatorAddrScreen,
  operatorExpiryCustomScreen,
  operatorCheckScreen,
  operatorExpiryScreen,
  operatorForeverScreen,
  operatorRevokeScreen,
  operatorsScreen,
  operatorTokenScreen,
} from './operators.js';
import { discloseScreen, disclosePickScreen } from './disclose.js';
import {
  exportConfirmScreen,
  exportKeystoreScreen,
  exportPasswordScreen,
  walletImportSecretScreen,
  walletImportTypeScreen,
  walletNameScreen,
  walletPassword2Screen,
  walletPasswordScreen,
  walletRemoveScreen,
  walletsScreen,
  walletSwitchScreen,
} from './wallets.js';

/** Screen id → module. */
export const SCREENS: Record<string, ScreenDef> = {
  home: homeScreen,
  balances: balancesScreen,
  unlock: unlockScreen,
  receive: receiveScreen,
  history: historyScreen,
  doctor: doctorScreen,

  'send-token': sendTokenScreen,
  'send-to': sendToScreen,
  'send-paste': sendPasteScreen,
  'send-check': sendCheckScreen,
  'send-amount': sendAmountScreen,
  'send-review': sendReviewScreen,
  'send-sign': sendSignScreen,
  'send-retype': sendRetypeScreen,
  'send-count': sendCountScreen,
  'send-error': sendErrorScreen,

  wallets: walletsScreen,
  'wallet-switch': walletSwitchScreen,
  'wallet-name': walletNameScreen,
  'wallet-password': walletPasswordScreen,
  'wallet-password2': walletPassword2Screen,
  'wallet-import-type': walletImportTypeScreen,
  'wallet-import-secret': walletImportSecretScreen,
  'export-confirm': exportConfirmScreen,
  'export-password': exportPasswordScreen,
  'export-keystore': exportKeystoreScreen,
  'wallet-remove': walletRemoveScreen,

  tokens: tokensScreen,
  'token-add': tokenAddScreen,
  'token-add-confirm': tokenAddConfirmScreen,
  'token-find': tokenFindScreen,
  'token-remove': tokenRemoveScreen,

  operators: operatorsScreen,
  'operator-token': operatorTokenScreen,
  'operator-addr': operatorAddrScreen,
  'operator-check': operatorCheckScreen,
  'operator-expiry': operatorExpiryScreen,
  'operator-expiry-custom': operatorExpiryCustomScreen,
  'operator-forever': operatorForeverScreen,
  'operator-revoke': operatorRevokeScreen,
  'tx-review': txReviewScreen,
  'tx-sign': txSignScreen,
  'tx-count': txCountScreen,
  'disclose-pick': disclosePickScreen,
  disclose: discloseScreen,

  contacts: contactsScreen,
  'contact-name': contactNameScreen,
  'contact-address': contactAddressScreen,
  'contact-remove': contactRemoveScreen,
  'contact-remove-confirm': contactRemoveConfirmScreen,

  settings: settingsScreen,
  'settings-network': settingsNetworkScreen,
  'settings-rpc': settingsRpcScreen,
  'settings-rpc-url': settingsRpcUrlScreen,
  'settings-key': settingsKeyScreen,

  'setup-welcome': setupWelcomeScreen,
  'setup-network': setupNetworkScreen,
  'setup-token': setupTokenScreen,
  'setup-gas': setupGasScreen,
};
