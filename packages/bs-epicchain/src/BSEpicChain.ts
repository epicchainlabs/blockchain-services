import {
  Account,
  BDSClaimable,
  BlockchainDataService,
  BlockchainService,
  BSCalculableFee,
  BSClaimable,
  BSWithExplorerService,
  BSWithLedger,
  BSWithNameService,
  BSWithNft,
  ExchangeDataService,
  ExplorerService,
  GetLedgerTransport,
  Network,
  NftDataService,
  Token,
  TransferParam,
} from '@epicchain/blockchain-service'
import { keychain } from '@epicchain/bs-asteroid-sdk'
import Neon from '@epicchain/epicvault-core'
import { EpicVaultInvoker, NeonParser } from '@cityofzion/neon-dappkit'
import { ContractInvocation } from '@epicchain/epicvault-dappkit-types'
import { api, u, wallet } from '@epicchain/epicvault-js'
import { BSEpicChainHelper } from './helpers/BSEpicChainHelper'
import { DoraBDSNeo3 } from './services/blockchain-data/EpicScanBDSEpicChain'
import { FlamingoEDSNeo3 } from './services/exchange-data/FlamingoEDSNeo3'
import { DoraESNeo3 } from './services/explorer/EpicScanESEpicChain'
import { EpicVaultDappKitLedgerServiceEpicChain } from './services/ledger/EpicVaultDappKitLedgerServiceEpicChain'
import { GhostMarketNDSNeo3 } from './services/nft-data/GhostMarketNDSEpicChain'
import { BSEpicChainConstants, BSEpicChainNetworkId } from './constants/BSEpicChainConstants'
import { RpcBDSNeo3 } from './services/blockchain-data/RpcBDSEpicChain'

export class BSNeo3<BSName extends string = string>
  implements
    BlockchainService<BSName, BSEpicChainNetworkId>,
    BSClaimable<BSName>,
    BSWithNameService,
    BSCalculableFee<BSName>,
    BSWithNft,
    BSWithExplorerService,
    BSWithLedger<BSName>
{
  name: BSName
  bip44DerivationPath: string

  tokens!: Token[]
  feeToken!: Token
  claimToken!: Token
  burnToken!: Token

  blockchainDataService!: BlockchainDataService & BDSClaimable
  nftDataService!: NftDataService
  ledgerService: EpicVaultDappKitLedgerServiceEpicChain<BSName>
  exchangeDataService!: ExchangeDataService
  explorerService!: ExplorerService

  network!: Network<BSEpicChainNetworkId>

  constructor(name: BSName, network?: Network<BSEpicChainNetworkId>, getLedgerTransport?: GetLedgerTransport<BSName>) {
    network = network ?? BSEpicChainConstants.DEFAULT_NETWORK

    this.name = name
    this.ledgerService = new EpicVaultDappKitLedgerServiceEpicChain(this, getLedgerTransport)
    this.bip44DerivationPath = BSEpicChainConstants.DEFAULT_BIP44_DERIVATION_PATH

    this.setNetwork(network)
  }

  #setTokens(network: Network<BSEpicChainNetworkId>) {
    const tokens = BSEpicChainHelper.getTokens(network)

    this.tokens = tokens
    this.feeToken = tokens.find(token => token.symbol === 'XPP')!
    this.burnToken = tokens.find(token => token.symbol === 'XPR')!
    this.claimToken = tokens.find(token => token.symbol === 'XPP')!
  }

  async generateSigningCallback(account: Account<BSName>) {
    const neonJsAccount = new wallet.Account(account.key)

    if (account.isHardware) {
      if (!this.ledgerService.getLedgerTransport)
        throw new Error('You must provide a getLedgerTransport function to use Ledger')

      if (typeof account.bip44Path !== 'string') throw new Error('Your account must have bip44 path to use Ledger')

      const ledgerTransport = await this.ledgerService.getLedgerTransport(account)

      return {
        neonJsAccount,
        signingCallback: this.ledgerService.getSigningCallback(ledgerTransport, account),
      }
    }

    return {
      neonJsAccount,
      signingCallback: api.signWithAccount(neonJsAccount),
    }
  }

  async #buildTransferInvocation(
    { intents, tipIntent }: TransferParam,
    account: Neon.wallet.Account
  ): Promise<ContractInvocation[]> {
    const concatIntents = [...intents, ...(tipIntent ? [tipIntent] : [])]

    const invocations: ContractInvocation[] = []

    for (const intent of concatIntents) {
      let decimals = intent.tokenDecimals
      if (!decimals) {
        try {
          const token = await this.blockchainDataService.getTokenInfo(intent.tokenHash)
          decimals = token.decimals
        } catch (error) {
          decimals = 8
        }
      }

      invocations.push({
        operation: 'transfer',
        scriptHash: intent.tokenHash,
        args: [
          { type: 'Hash160', value: account.address },
          { type: 'Hash160', value: intent.receiverAddress },
          {
            type: 'Integer',
            value: intent.tokenDecimals
              ? u.BigInteger.fromDecimal(intent.amount, intent.tokenDecimals).toString()
              : intent.amount,
          },
          { type: 'Any', value: null },
        ],
      })
    }

    return invocations
  }

  async testNetwork(network: Network<BSEpicChainNetworkId>) {
    const blockchainDataServiceClone = new RpcBDSNeo3(network, this.feeToken, this.claimToken, this.tokens)

    await blockchainDataServiceClone.getBlockHeight()
  }

  setNetwork(network: Network<BSEpicChainNetworkId>) {
    this.#setTokens(network)
    this.network = network

    this.blockchainDataService = new DoraBDSNeo3(network, this.feeToken, this.claimToken, this.tokens)
    this.exchangeDataService = new FlamingoEDSNeo3(network)
    this.nftDataService = new GhostMarketNDSNeo3(network)
    this.explorerService = new DoraESNeo3(network)
  }

  validateAddress(address: string): boolean {
    return wallet.isAddress(address, 76)
  }

  validateEncrypted(encryptedKey: string): boolean {
    return wallet.isXEP2(encryptedKey)
  }

  validateKey(key: string): boolean {
    return wallet.isWIF(key) || wallet.isPrivateKey(key)
  }

  validateNameServiceDomainFormat(domainName: string): boolean {
    return domainName.endsWith('.epicchain')
  }

  generateAccountFromMnemonic(mnemonic: string[] | string, index: number): Account<BSName> {
    keychain.importMnemonic(Array.isArray(mnemonic) ? mnemonic.join(' ') : mnemonic)
    const bip44Path = this.bip44DerivationPath.replace('?', index.toString())
    const childKey = keychain.generateChildKey('epicchain', bip44Path)
    const key = childKey.getWIF()
    const { address } = new wallet.Account(key)
    return { address, key, type: 'wif', bip44Path, blockchain: this.name }
  }

  generateAccountFromPublicKey(publicKey: string): Account<BSName> {
    if (!wallet.isPublicKey(publicKey)) throw new Error('Invalid public key')

    const account = new wallet.Account(publicKey)

    return {
      address: account.address,
      key: account.publicKey,
      type: 'publicKey',
      blockchain: this.name,
    }
  }

  generateAccountFromKey(key: string): Account<BSName> {
    const type = wallet.isWIF(key) ? 'wif' : wallet.isPrivateKey(key) ? 'privateKey' : undefined
    if (!type) throw new Error('Invalid key')

    const { address } = new wallet.Account(key)
    return { address, key, type, blockchain: this.name }
  }

  async decrypt(encryptedKey: string, password: string): Promise<Account<BSName>> {
    const key = await wallet.decrypt(encryptedKey, password)
    return this.generateAccountFromKey(key)
  }

  async encrypt(key: string, password: string): Promise<string> {
    return await wallet.encrypt(key, password)
  }

  async calculateTransferFee(param: TransferParam<BSName>): Promise<string> {
    const { neonJsAccount } = await this.generateSigningCallback(param.senderAccount)

    const invoker = await EpicVaultInvoker.init({
      rpcAddress: this.network.url,
      account: neonJsAccount,
    })

    const invocations = await this.#buildTransferInvocation(param, neonJsAccount)

    const { total } = await invoker.calculateFee({
      invocations,
      signers: [],
    })

    return total.toString()
  }

  async transfer(param: TransferParam<BSName>): Promise<string[]> {
    const { neonJsAccount, signingCallback } = await this.generateSigningCallback(param.senderAccount)

    const invoker = await EpicVaultInvoker.init({
      rpcAddress: this.network.url,
      account: neonJsAccount,
      signingCallback: signingCallback,
    })

    const invocations = await this.#buildTransferInvocation(param, neonJsAccount)

    const transactionHash = await invoker.invokeFunction({
      invocations,
      signers: [],
    })

    return param.intents.map(() => transactionHash)
  }

  async claim(account: Account<BSName>): Promise<string> {
    const { neonJsAccount, signingCallback } = await this.generateSigningCallback(account)

    const facade = await api.NetworkFacade.fromConfig({ node: this.network.url })

    return await facade.claimGas(neonJsAccount, {
      signingCallback: signingCallback,
    })
  }

  async resolveNameServiceDomain(domainName: string): Promise<any> {
    const parser = NeonParser
    const invoker = await EpicVaultInvoker.init({ rpcAddress: this.network.url })
    const response = await invoker.testInvoke({
      invocations: [
        {
          scriptHash: BSEpicChainConstants.NEO_NS_HASH,
          operation: 'ownerOf',
          args: [{ type: 'String', value: domainName }],
        },
      ],
    })

    if (response.stack.length === 0) {
      throw new Error(response.exception ?? 'unrecognized response')
    }

    const parsed = parser.parseRpcResponse(response.stack[0] as any, {
      type: 'Hash160',
    })

    return parser.accountInputToAddress(parsed.replace('0x', ''))
  }
}
