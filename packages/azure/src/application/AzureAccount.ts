/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  SubscriptionClient,
  Subscription,
} from '@azure/arm-resources-subscriptions'
import {
  ClientSecretCredential,
  WorkloadIdentityCredential,
} from '@azure/identity'
import { ConsumptionManagementClient } from '@azure/arm-consumption'
import { AdvisorManagementClient } from '@azure/arm-advisor'

import {
  ComputeEstimator,
  StorageEstimator,
  NetworkingEstimator,
  MemoryEstimator,
  UnknownEstimator,
  CloudProviderAccount,
  EmbodiedEmissionsEstimator,
} from '@cloud-carbon-footprint/core'
import {
  configLoader,
  EstimationResult,
  GroupBy,
  Logger,
  LookupTableInput,
  RecommendationResult,
} from '@cloud-carbon-footprint/common'
import R from 'ramda'
import AzureCredentialsProvider from './AzureCredentialsProvider'
import ConsumptionManagementService from '../lib/ConsumptionManagement'
import AdvisorRecommendations from '../lib/AdvisorRecommendations'
import { AZURE_CLOUD_CONSTANTS } from '../domain'

export default class AzureAccount extends CloudProviderAccount {
  private credentials: ClientSecretCredential | WorkloadIdentityCredential
  private subscriptionClient: SubscriptionClient
  private logger: Logger

  constructor() {
    super()

    this.logger = new Logger('AzureAccount')
  }

  public async initializeAccount(): Promise<void> {
    try {
      this.credentials = await AzureCredentialsProvider.create()
      this.subscriptionClient = new SubscriptionClient(this.credentials)
    } catch (e) {
      throw new Error(`Azure initializeAccount failed. Reason: ${e.message}`)
    }
  }

  public async getDataFromAdvisorManagement(): Promise<RecommendationResult[]> {
    const subscriptions = await this.getSubscriptions()
    const recommendations = await Promise.all(
      subscriptions.map(async (subscription: Subscription) => {
        try {
          return await this.getRecommendationsForSubscription(
            subscription.subscriptionId,
          )
        } catch (e) {
          this.logger.warn(
            `Unable to get Advisor recommendations data for Azure subscription ${subscription.subscriptionId}: ${e.message}`,
          )
          return []
        }
      }),
    )
    return recommendations.flat()
  }

  public async getDataFromConsumptionManagement(
    startDate: Date,
    endDate: Date,
    grouping: GroupBy,
  ): Promise<EstimationResult[]> {
    const subscriptions = await this.getSubscriptions()

    const AZURE = configLoader().AZURE

    const requests = this.createSubscriptionRequests(
      subscriptions,
      startDate,
      endDate,
      grouping,
    )

    // If chunking by day is enabled, synchronously fetch each subscription
    if (AZURE.CONSUMPTION_CHUNKS_DAYS) {
      const estimationResults: Array<Array<EstimationResult>> = []
      for (const request of requests) {
        estimationResults.push(await request())
      }
      return estimationResults.flat()
    }

    // If chunking by day is disabled, asynchronously fetch all or chunked subscriptions
    const chunkedRequests = AZURE.SUBSCRIPTION_CHUNKS
      ? R.splitEvery(AZURE.SUBSCRIPTION_CHUNKS, requests)
      : [requests]
    this.logger.debug(
      `Fetching Azure consumption data with ${AZURE.SUBSCRIPTION_CHUNKS}} 1} chunk(s)`,
    )

    // TODO: Remove before release.
    console.time(`Azure Subscriptions: ${AZURE.SUBSCRIPTION_CHUNKS} chunk(s)`)
    const estimationResults = []
    for (const requests of chunkedRequests) {
      estimationResults.push(
        await Promise.all(requests.map(async (request) => request())),
      )
    }
    console.timeEnd(
      `Azure Subscriptions: ${AZURE.SUBSCRIPTION_CHUNKS || 1} chunk(s)`,
    )

    return R.flatten(estimationResults)
  }

  public async getSubscriptions(): Promise<Subscription[]> {
    const subscriptions = []
    for await (const subscription of this.subscriptionClient.subscriptions.list()) {
      subscriptions.push(subscription)
    }

    if (subscriptions.length === 0) {
      this.logger.warn(
        'No subscription returned for these Azure credentials, be sure the registered application has ' +
          'enough permissions. Go to https://www.cloudcarbonfootprint.org/docs/azure/ for more information.',
      )
    }

    return subscriptions
  }

  static getDataFromConsumptionManagementInputData(
    inputData: LookupTableInput[],
  ) {
    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
    )
    return consumptionManagementService.getEstimatesFromInputData(inputData)
  }

  private async getRecommendationsForSubscription(subscriptionId: string) {
    const advisorRecommendations = new AdvisorRecommendations(
      new ComputeEstimator(),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new AdvisorManagementClient(this.credentials, subscriptionId),
    )
    return advisorRecommendations.getRecommendations()
  }

  private async getDataForSubscription(
    startDate: Date,
    endDate: Date,
    subscriptionId: string,
    grouping: GroupBy,
  ) {
    const consumptionManagementService = new ConsumptionManagementService(
      new ComputeEstimator(),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AZURE_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AZURE_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AZURE_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AZURE_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AZURE_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN,
      ),
      new ConsumptionManagementClient(this.credentials, subscriptionId),
    )
    return consumptionManagementService.getEstimates(
      startDate,
      endDate,
      grouping,
    )
  }

  /**
   * Creates an array of functions that each return a promise for EstimationResults.
   * Each Promise corresponds to a mapped getDataForSubscription result for that subscription.
   *
   * @param {Subscription[]} subscriptions - An array of subscription information to retrieve data for.
   * @param {Date} startDate - The start date for the estimation request period.
   * @param {Date} endDate - The end date for the estimation request period.
   * @param {GroupBy} grouping - The grouping method used intended for the estimation request.
   * @returns {(() => Promise<EstimationResult[]>)[]} An array of functions that each return a promise for an array of estimation results.
   */
  private createSubscriptionRequests(
    subscriptions: Subscription[],
    startDate: Date,
    endDate: Date,
    grouping: GroupBy,
  ): (() => Promise<EstimationResult[]>)[] {
    return subscriptions.map((subscription) => {
      return async () => {
        try {
          this.logger.info(`Getting data for ${subscription.displayName}...`)
          return await this.getDataForSubscription(
            startDate,
            endDate,
            subscription.subscriptionId,
            grouping,
          )
        } catch (e) {
          this.logger.warn(
            `Unable to get estimate data for Azure subscription ${subscription.subscriptionId}: ${e.message}`,
          )
          return []
        }
      }
    })
  }
}
