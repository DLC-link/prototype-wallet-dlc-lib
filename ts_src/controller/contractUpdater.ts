import {
  CreateCetAdaptorSignatureRequest,
  CreateDlcTransactionsRequest,
  CreateDlcTransactionsResponse,
  VerifyCetAdaptorSignatureRequest,
} from '../cfd-dlc-js-wasm'
import cfddlcjsInit from '../cfd-dlc-js-wasm'
import { ContractState } from '../models/contract/contract'
import {
  AcceptedContract,
  BroadcastContract,
  FailedContract,
  isContractOfState,
  OfferedContract,
  RejectedContract,
  SignedContract,
} from '../models/contract'
import { PartyParams } from '../models/partyParams'
import { RangeInfo } from '../models/rangeInfo'
import {
  TxInputInfo,
  txInputInfoToTxInInfoRequest,
} from '../models/txInputInfo'
import { groupByIgnoringDigits } from '../utils/decomposition'
import { DigitTrie, trieExplore, trieInsert } from '../utils/digitTrie'
import { DlcError } from '../errors/dlcError'
import { getOwnFee } from '../utils/feeEstimator'
import { isDigitTrie } from '../utils/outcomeInfo'
import { Utxo } from '../models/utxo'
import { FundingInput } from '../models/messages/offerMessage'
import { Payout } from '../models/payout'
import {
  ContractInfo,
  EnumeratedContractDescriptor,
  getContractPayouts,
  getNumericOutcomeDescriptorRangePayouts as getNumericOutcomeDescriptorRangeOutcomes,
  isEnumeratedContractDescriptor,
  isNumericOutcomeContractDescriptor,
  NumericOutcomeContractDescriptor,
} from '../models/messages/contract'
import { Transaction, address, script } from 'bitcoinjs-lib'
import { ECPairFactory, ECPairAPI } from 'ecpair'
import { computeContractId } from '../models/contract/acceptedContract'
import { getSerialId } from '../utils/random'
import { FundingSignature } from '../models/messages/signMessage'
import { SerialIdOrderer } from '../utils/serialIdOrderer'
import { Blockchain } from '../interfaces/blockchain'
import { Wallet } from '../interfaces/wallet'
import {
  isDigitDecompositionEventDescriptor,
  isEnumeratedEventDescriptor,
  OracleInfo,
} from '../models/oracle'
import * as tinysecp256k1 from 'tiny-secp256k1'

const cfddlcjs = cfddlcjsInit.getCfddlc()

const ECPair: ECPairAPI = ECPairFactory(tinysecp256k1)

interface SigParams {
  fundTxId: string
  fundTxOutAmount: number
  cetsHex: string[]
  fundPrivkey: string
  offerParams: PartyParams
  acceptParams: PartyParams
}

const notEnoughUtxoErrorMessage = 'Not enough UTXO for collateral and fees.'

export class ContractUpdater {
  constructor(readonly wallet: Wallet, readonly blockchain: Blockchain) {}

  private async getPartyInputs(
    utxos: ReadonlyArray<Utxo>,
    collateral: number
  ): Promise<PartyParams> {
    const fundPubkey = await this.wallet.getNewPublicKey()
    const changeAddress = await this.wallet.getNewAddress()
    const payoutAddress = await this.wallet.getNewAddress()
    // TODO(tibo): get network param from wallet
    const changeScriptPubkey = address
      .toOutputScript(changeAddress, this.wallet.getNetwork())
      .toString('hex')
    const payoutScriptPubkey = address
      .toOutputScript(payoutAddress, this.wallet.getNetwork())
      .toString('hex')

    let inputAmount = 0
    const inputs: TxInputInfo[] = []

    for (const input of utxos) {
      inputAmount += input.amount
      inputs.push({
        outpoint: {
          txid: input.txid,
          vout: input.vout,
        },
        redeemScript: input.redeemScript ? input.redeemScript : '',
        maxWitnessLen: 107,
        serialId: getSerialId(),
        address: input.address,
        amount: input.amount,
      })
    }

    return {
      fundPubkey,
      changeScriptPubkey,
      changeSerialId: getSerialId(),
      payoutScriptPubkey,
      payoutSerialId: getSerialId(),
      inputs: inputs,
      collateral,
      inputAmount,
    }
  }

  async toAcceptContract(contract: OfferedContract): Promise<AcceptedContract> {
    let acceptParams = undefined
    const acceptFundingInputsInfo: FundingInput[] = []
    try {
      const estimatedInputs = 2
      let utxos = []
      const ownCollateral =
        contract.contractInfo.totalCollateral - contract.offerParams.collateral
      const ownFee = getOwnFee(contract.feeRatePerVByte, estimatedInputs)
      utxos = await this.wallet.getUtxosForAmount(
        ownCollateral + ownFee,
        contract.feeRatePerVByte
      )

      acceptParams = await this.getPartyInputs(utxos, ownCollateral)

      for (const input of acceptParams.inputs) {
        const prevTx = await this.blockchain.getTransaction(input.outpoint.txid)
        acceptFundingInputsInfo.push({
          inputSerialId: input.serialId,
          prevTx,
          prevTxVout: input.outpoint.vout,
          sequence: 0xffffffff,
          maxWitnessLen: 107,
          redeemScript: input.redeemScript,
        })
      }
    } catch (e) {
      throw new DlcError(notEnoughUtxoErrorMessage)
    }

    const payouts: Payout[] = getContractPayouts(contract.contractInfo)

    const dlcTransactions = await createDlcTransactions(
      contract,
      acceptParams,
      payouts
    )

    const fundTxHex = dlcTransactions.fundTxHex
    const fundTransaction = Transaction.fromHex(fundTxHex)
    const fundTxId = fundTransaction.getId()
    const fundTxOutAmount = Number(
      fundTransaction.outs[dlcTransactions.fundVout].value
    )
    const cetsHex = dlcTransactions.cetsHex
    const fundingScriptPubkey = dlcTransactions.fundingScriptPubkey

    const fundPrivkey = await this.wallet.getPrivateKeyForPublicKey(
      acceptParams.fundPubkey
    )
    const sigParams: SigParams = {
      fundTxId,
      fundTxOutAmount,
      cetsHex,
      acceptParams,
      fundPrivkey,
      offerParams: contract.offerParams,
    }
    const [outcomeInfo, acceptAdaptorSignatures] = await getOutcomesInfo(
      contract.contractInfo,
      sigParams
    )

    const acceptRefundSignature = await this.wallet.getDerTxSignatureFromPubkey(
      Transaction.fromHex(dlcTransactions.refundTxHex),
      0,
      sigParams.fundTxOutAmount,
      acceptParams.fundPubkey,
      fundingScriptPubkey
    )

    const id = computeContractId(
      fundTxId,
      dlcTransactions.fundVout,
      contract.temporaryContractId
    )

    return {
      ...contract,
      id,
      state: ContractState.Accepted,
      acceptParams,
      outcomeInfo,
      acceptFundingInputsInfo,
      acceptRefundSignature,
      dlcTransactions: {
        fund: dlcTransactions.fundTxHex,
        cets: dlcTransactions.cetsHex,
        refund: dlcTransactions.refundTxHex,
        fundOutputIndex: dlcTransactions.fundVout,
        fundScriptPubkey: dlcTransactions.fundingScriptPubkey,
      },
      acceptAdaptorSignatures,
    }
  }

  async toSignedContract(
    contract: AcceptedContract,
    offerRefundSignature: string,
    offerCetAdaptorSignatures: ReadonlyArray<string>,
    offerFundTxSignatures: ReadonlyArray<FundingSignature>
  ): Promise<SignedContract> {
    return {
      ...contract,
      state: ContractState.Signed,
      offerRefundSignature,
      offerCetAdaptorSignatures: offerCetAdaptorSignatures,
      offerFundTxSignatures,
    }
  }

  async toBroadcast(contract: SignedContract): Promise<BroadcastContract> {
    const fundTxHex = contract.dlcTransactions.fund

    const inputOrderer = new SerialIdOrderer(
      contract.acceptParams.inputs
        .map((x) => x.serialId)
        .concat(contract.offerParams.inputs.map((x) => x.serialId))
    )

    const fundTx = Transaction.fromHex(fundTxHex)

    for (let i = 0; i < contract.acceptParams.inputs.length; i++) {
      const input = contract.acceptParams.inputs[i]
      if (!input.address) {
        throw new DlcError('Accept party should have its input addresses set')
      }
      const index = inputOrderer.getIndexForId(
        contract.acceptParams.inputs[i].serialId
      )

      await this.wallet.signP2WPKHTxInput(
        fundTx,
        index,
        input.amount,
        input.address
      )
    }

    for (let i = 0; i < contract.offerFundTxSignatures.length; i++) {
      const signature = contract.offerFundTxSignatures[i]
      const index = inputOrderer.getIndexForId(
        contract.offerParams.inputs[i].serialId
      )
      fundTx.ins[index].witness = signature.witnessElements.map((x) =>
        Buffer.from(x.witness, 'hex')
      )
    }

    await this.blockchain.sendRawTransaction(fundTx.toHex())

    return { ...contract, state: ContractState.Broadcast }
  }

  async toRejectedContract(
    contract: OfferedContract | AcceptedContract | SignedContract,
    reason?: string
  ): Promise<RejectedContract> {
    if (
      isContractOfState(contract, ContractState.Accepted, ContractState.Signed)
    ) {
      await this.unlockUtxos(contract)
    }
    return {
      ...contract,
      state: ContractState.Rejected,
      reason,
    }
  }

  async toFailedContract(
    contract: AcceptedContract | SignedContract,
    reason: string
  ): Promise<FailedContract> {
    const states = [ContractState.Offered, ContractState.Accepted] as const
    if (isContractOfState(contract, ...states)) await this.unlockUtxos(contract)
    return {
      ...contract,
      state: ContractState.Failed,
      reason,
    }
  }

  private async unlockUtxos(
    contract: AcceptedContract | SignedContract
  ): Promise<void> {
    const inputs = contract.acceptParams.inputs
    for (const input of inputs) {
      await this.wallet.unreserveUtxo(input.outpoint.txid, input.outpoint.vout)
    }
  }
}

function verifyTxInputSignature(
  txHex: string,
  inputIndex: number,
  inputAmount: number,
  outputScript: string,
  pubkey: string,
  derSignature: string
): boolean {
  const tx = Transaction.fromHex(txHex)
  const hash = tx.hashForWitnessV0(
    inputIndex,
    Buffer.from(outputScript, 'hex'),
    inputAmount,
    0x01
  )
  const ecpair = ECPair.fromPublicKey(Buffer.from(pubkey, 'hex'))
  const fullSignature = Buffer.from(derSignature.concat('01'), 'hex')
  const rawSignature = script.signature.decode(fullSignature).signature
  return ecpair.verify(hash, rawSignature)
}

export function verifyContractSignatures(
  contract: SignedContract,
  fundOutputValue: number
): boolean {
  const refundSignature = contract.offerRefundSignature
  const adaptorSignatures = contract.offerCetAdaptorSignatures
  const isValid = verifyCetAdaptorSignatures(contract, adaptorSignatures)
  if (!isValid) {
    return false
  }

  return verifyTxInputSignature(
    contract.dlcTransactions.refund,
    0,
    fundOutputValue,
    contract.dlcTransactions.fundScriptPubkey,
    contract.offerParams.fundPubkey,
    refundSignature
  )
}

async function getAdaptorSignature(
  cetHex: string,
  offerParams: PartyParams,
  acceptParams: PartyParams,
  oracleInfo: OracleInfo,
  fundingSk: string,
  fundTxId: string,
  fundOutputValue: number,
  msgs: string[]
): Promise<string> {
  const cetSignRequest: CreateCetAdaptorSignatureRequest = {
    cetHex,
    privkey: fundingSk,
    fundTxId,
    offerFundPubkey: offerParams.fundPubkey,
    acceptFundPubkey: acceptParams.fundPubkey,
    fundInputAmount: fundOutputValue,
    oraclePubkey: oracleInfo.oracleAnnouncement.oraclePublicKey,
    oracleRValues: oracleInfo.oracleAnnouncement.oracleEvent.oracleNonces.slice(
      0,
      msgs.length
    ),
    messages: msgs,
  }
  const res = await cfddlcjs.CreateCetAdaptorSignature(cetSignRequest)
  return res.signature
}

async function createDlcTransactions(
  contract: OfferedContract,
  acceptParams: PartyParams,
  payouts: Payout[]
): Promise<CreateDlcTransactionsResponse> {
  const dlcTxRequest: CreateDlcTransactionsRequest = {
    payouts,
    offerFundPubkey: contract.offerParams.fundPubkey,
    offerPayoutScriptPubkey: contract.offerParams.payoutScriptPubkey,
    offerPayoutSerialId: contract.offerParams.payoutSerialId,
    acceptFundPubkey: acceptParams.fundPubkey,
    acceptPayoutScriptPubkey: acceptParams.payoutScriptPubkey,
    acceptPayoutSerialId: acceptParams.payoutSerialId,
    offerInputAmount: contract.offerParams.inputAmount,
    offerCollateralAmount: contract.offerParams.collateral,
    acceptInputAmount: acceptParams.inputAmount,
    acceptCollateralAmount: acceptParams.collateral,
    cetLockTime: contract.contractMaturityBound,
    refundLocktime: contract.contractTimeOut,
    offerInputs: contract.offerParams.inputs.map(txInputInfoToTxInInfoRequest),
    offerChangeScriptPubkey: contract.offerParams.changeScriptPubkey,
    offerChangeSerialId: contract.offerParams.changeSerialId,
    acceptInputs: acceptParams.inputs.map(txInputInfoToTxInInfoRequest),
    acceptChangeScriptPubkey: acceptParams.changeScriptPubkey,
    acceptChangeSerialId: acceptParams.changeSerialId,
    feeRate: contract.feeRatePerVByte,
    fundOutputSerialId: contract.fundOutputSerialId,
  }
  return cfddlcjs.CreateDlcTransactions(dlcTxRequest)
}

async function getDecompositionOutcomeInfo(
  descriptor: NumericOutcomeContractDescriptor,
  totalCollateral: number,
  oracleInfo: OracleInfo,
  sigParams: SigParams
): Promise<[DigitTrie<RangeInfo>, string[]]> {
  const outcomeTrie: DigitTrie<RangeInfo> = { root: { edges: [] } }
  const adaptorPairs: string[] = []
  let adaptorCounter = 0
  const rangeOutcomes = getNumericOutcomeDescriptorRangeOutcomes(
    descriptor,
    totalCollateral
  )
  const eventDescriptor =
    oracleInfo.oracleAnnouncement.oracleEvent.eventDescriptor
  if (!isDigitDecompositionEventDescriptor(eventDescriptor)) {
    throw new DlcError('Expected digit decomposition descriptor')
  }
  for (let i = 0; i < rangeOutcomes.length; i++) {
    const outcome = rangeOutcomes[i]
    const groups = groupByIgnoringDigits(
      outcome.start,
      outcome.start + outcome.count - 1,
      eventDescriptor.base,
      oracleInfo.oracleAnnouncement.oracleEvent.oracleNonces.length
    )
    for (let j = 0; j < groups.length; j++) {
      const cetHex = sigParams.cetsHex[i]
      const adaptorSignature = await getAdaptorSignature(
        cetHex,
        sigParams.offerParams,
        sigParams.acceptParams,
        oracleInfo,
        sigParams.fundPrivkey,
        sigParams.fundTxId,
        sigParams.fundTxOutAmount,
        groups[j].map((x) => x.toString())
      )
      adaptorPairs.push(adaptorSignature)
      const rangeInfo: RangeInfo = {
        cetIndex: i,
        adaptorSignatureIndex: adaptorCounter++,
      }
      trieInsert(outcomeTrie, groups[j], rangeInfo)
    }
  }
  return [outcomeTrie, adaptorPairs]
}

async function getEnumerationOutcomeInfo(
  descriptor: EnumeratedContractDescriptor,
  oracleInfo: OracleInfo,
  sigParams: SigParams
): Promise<[string[], string[]]> {
  const adaptorPairs: string[] = []
  const outcomes: string[] = []
  for (let i = 0; i < descriptor.payouts.length; i++) {
    const outcome = descriptor.payouts[i]
    outcomes.push(outcome.outcome)
    const cetHex = sigParams.cetsHex[i]
    const adaptorPair = await getAdaptorSignature(
      cetHex,
      sigParams.offerParams,
      sigParams.acceptParams,
      oracleInfo,
      sigParams.fundPrivkey,
      sigParams.fundTxId,
      sigParams.fundTxOutAmount,
      [outcome.outcome]
    )
    adaptorPairs.push(adaptorPair)
  }
  return [outcomes, adaptorPairs]
}

async function getOutcomesInfo(
  contractInfo: ContractInfo,
  sigParams: SigParams
): Promise<[DigitTrie<RangeInfo> | string[], string[]]> {
  if (
    isEnumeratedContractDescriptor(contractInfo.contractInfo.contractDescriptor)
  ) {
    return getEnumerationOutcomeInfo(
      contractInfo.contractInfo.contractDescriptor,
      contractInfo.contractInfo.oracleInfo,
      sigParams
    )
  } else if (
    isNumericOutcomeContractDescriptor(
      contractInfo.contractInfo.contractDescriptor
    )
  ) {
    return getDecompositionOutcomeInfo(
      contractInfo.contractInfo.contractDescriptor,
      contractInfo.totalCollateral,
      contractInfo.contractInfo.oracleInfo,
      sigParams
    )
  } else {
    throw Error('Unsupported descriptor')
  }
}

function verifyCetAdaptorSignaturesForDecomposition(
  contract: AcceptedContract | SignedContract,
  digitTrie: DigitTrie<RangeInfo>,
  adaptorSigs: ReadonlyArray<string>
): boolean {
  const fundTx = Transaction.fromHex(contract.dlcTransactions.fund)
  for (const trieVal of trieExplore(digitTrie)) {
    const adaptorSig = adaptorSigs[trieVal.data.adaptorSignatureIndex]
    const isValid = verifyCetAdaptorSignature(
      adaptorSig,
      contract.dlcTransactions.cets[trieVal.data.cetIndex],
      contract.contractInfo.contractInfo.oracleInfo,
      contract.offerParams.fundPubkey,
      contract.acceptParams.fundPubkey,
      fundTx.getId(),
      fundTx.outs[contract.dlcTransactions.fundOutputIndex].value,
      trieVal.path.map((x: number) => x.toString())
    )
    if (!isValid) {
      return false
    }
  }

  return true
}

function verifyCetAdaptorSignaturesForEnumeration(
  contract: AcceptedContract | SignedContract,
  outcomes: string[],
  adaptorSigs: ReadonlyArray<string>
): boolean {
  const fundTx = Transaction.fromHex(contract.dlcTransactions.fund)
  return outcomes.every((x, i) =>
    verifyCetAdaptorSignature(
      adaptorSigs[i],
      contract.dlcTransactions.cets[i],
      contract.contractInfo.contractInfo.oracleInfo,
      contract.offerParams.fundPubkey,
      contract.acceptParams.fundPubkey,
      fundTx.getId(),
      fundTx.outs[contract.dlcTransactions.fundOutputIndex].value,
      [x]
    )
  )
}

function verifyCetAdaptorSignatures(
  contract: AcceptedContract | SignedContract,
  adaptorSignatures: ReadonlyArray<string>
): boolean {
  const descriptor =
    contract.contractInfo.contractInfo.oracleInfo.oracleAnnouncement.oracleEvent
      .eventDescriptor
  if (isEnumeratedEventDescriptor(descriptor)) {
    return verifyCetAdaptorSignaturesForEnumeration(
      contract,
      descriptor.outcomes.slice(),
      adaptorSignatures
    )
  } else if (
    isDigitDecompositionEventDescriptor(descriptor) &&
    isDigitTrie(contract.outcomeInfo)
  ) {
    return verifyCetAdaptorSignaturesForDecomposition(
      contract,
      contract.outcomeInfo,
      adaptorSignatures
    )
  }

  throw Error('Unknown descriptor or invalid state')
}

async function verifyCetAdaptorSignature(
  adaptorSig: string,
  cet: string,
  oracleInfo: OracleInfo,
  offerFundPubkey: string,
  acceptFundPubkey: string,
  fundTxId: string,
  fundOutputValue: number,
  msgs: string[]
): Promise<boolean> {
  const verifyCetSignatureRequest: VerifyCetAdaptorSignatureRequest = {
    cetHex: cet,
    adaptorSignature: adaptorSig,
    messages: msgs,
    oracleRValues: oracleInfo.oracleAnnouncement.oracleEvent.oracleNonces.slice(
      0,
      msgs.length
    ),
    oraclePubkey: oracleInfo.oracleAnnouncement.oraclePublicKey,
    offerFundPubkey,
    acceptFundPubkey,
    fundTxId,
    fundInputAmount: fundOutputValue,
    verifyAccept: false,
  }
  const valid = (
    await cfddlcjs.VerifyCetAdaptorSignature(verifyCetSignatureRequest)
  ).valid
  return valid
}
