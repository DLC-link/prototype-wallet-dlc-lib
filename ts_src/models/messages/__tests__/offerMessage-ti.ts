/**
 * This module was automatically generated by `ts-interface-builder`
 */
import * as t from 'ts-interface-checker'
// tslint:disable:object-literal-key-quotes

export const FundingInput = t.iface([], {
  inputSerialId: 'number',
  prevTx: 'string',
  prevTxVout: 'number',
  sequence: 'number',
  maxWitnessLen: 'number',
  redeemScript: 'string',
})

export const OfferMessage = t.iface([], {
  protocolVersion: t.lit(1),
  contractFlags: 'number',
  chainHash: 'string',
  temporaryContractId: 'string',
  contractInfo: 'ContractInfo',
  fundingPubkey: 'string',
  payoutSpk: 'string',
  payoutSerialId: 'number',
  offerCollateral: 'number',
  fundingInputs: t.array('FundingInput'),
  changeSpk: 'string',
  changeSerialId: 'number',
  fundOutputSerialId: 'number',
  feeRatePerVb: 'number',
  cetLocktime: 'number',
  refundLocktime: 'number',
})

const exportedTypeSuite: t.ITypeSuite = {
  FundingInput,
  OfferMessage,
}
export default exportedTypeSuite
