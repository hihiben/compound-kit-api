import BigNumberJS from 'bignumber.js';
import {
  EventBody,
  EventPathParameters,
  Route,
  formatJSONResponse,
  newHttpError,
  newInternalServerError,
} from 'src/libs/api';
import { LEVERAGE_BORROW_SCALE } from 'src/constants';
import { LeverageQuotation, QuoteAPIResponseBody } from 'src/types';
import { MarketInfo, Service, calcHealthRate, calcNetAPR, calcUtilization } from 'src/libs/compound-v3';
import * as apisdk from '@protocolink/api';
import * as common from '@protocolink/common';
import { utils } from 'ethers';
import { validateMarket } from 'src/validations';

type GetLeverageQuotationRouteParams = EventPathParameters<{ chainId: string; marketId: string }> &
  EventBody<{ account?: string; token?: common.TokenObject; amount?: string; slippage?: number }>;

type GetLeverageQuotationResponseBody = QuoteAPIResponseBody<LeverageQuotation>;

export const v1GetLeverageQuotationRoute: Route<GetLeverageQuotationRouteParams> = {
  method: 'POST',
  path: '/v1/markets/{chainId}/{marketId}/leverage',
  handler: async (event) => {
    const chainId = Number(event.pathParameters.chainId);
    const marketId = event.pathParameters.marketId.toUpperCase();
    if (!validateMarket(chainId, marketId)) {
      throw newHttpError(400, { code: '400.1', message: 'market does not exist' });
    }

    if (!event.body) {
      throw newHttpError(400, { code: '400.2', message: 'body is invalid' });
    }

    let account = event.body.account;
    if (!account) {
      throw newHttpError(400, { code: '400.3', message: `account can't be blank` });
    }
    try {
      account = utils.getAddress(account);
    } catch {
      throw newHttpError(400, { code: '400.4', message: 'account is invalid' });
    }

    const service = new Service(chainId);

    let marketInfo: MarketInfo;
    try {
      marketInfo = await service.getMarketInfo(marketId, account);
    } catch (err) {
      throw newInternalServerError(err);
    }
    const { utilization, healthRate, netAPR, borrowUSD } = marketInfo;
    const currentPosition = { utilization, healthRate, netAPR, totalDebt: borrowUSD };

    let leverageTimes = '0';
    const logics: GetLeverageQuotationResponseBody['logics'] = [];
    let approvals: GetLeverageQuotationResponseBody['approvals'] = [];
    let targetPosition = currentPosition;
    if (event.body.token && event.body.amount && Number(event.body.amount) > 0) {
      const { token, amount, slippage } = event.body;
      const {
        baseToken,
        baseTokenPrice,
        supplyAPR,
        supplyUSD,
        borrowAPR,
        borrowUSD,
        collateralUSD,
        borrowCapacityUSD,
        liquidationLimit,
        collaterals,
      } = marketInfo;

      const leverageToken = common.Token.from(token);
      const leverageCollateral = collaterals.find(({ asset }) => asset.is(leverageToken.unwrapped));
      if (!leverageCollateral) {
        throw newHttpError(400, { code: '400.5', message: 'leverage token is not collateral' });
      }
      const leverageUSD = new BigNumberJS(amount).times(leverageCollateral.assetPrice);

      // 1. new balancer flash loan logics and append loan logic
      const [flashLoanLoanLogic, flashLoanRepayLogic] = apisdk.protocols.balancerv2.newFlashLoanLogicPair([
        { token: leverageToken, amount },
      ]);
      logics.push(flashLoanLoanLogic);

      // 2. new and append compound v3 supply collateral logic
      logics.push(
        apisdk.protocols.compoundv3.newSupplyCollateralLogic({
          marketId,
          input: { token: leverageToken, amount },
        })
      );

      // 3. new and append compound v3 borrow logic
      const leverageBorrowUSD = leverageUSD.times(LEVERAGE_BORROW_SCALE);
      const leverageBorrowAmount = common.formatBigUnit(
        leverageBorrowUSD.div(baseTokenPrice),
        baseToken.decimals,
        'floor'
      );
      logics.push(
        apisdk.protocols.compoundv3.newBorrowLogic({
          marketId,
          output: { token: baseToken, amount: leverageBorrowAmount },
        })
      );

      // 4. new and append paraswap swap token logic
      const quotation = await apisdk.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
        input: { token: baseToken, amount: leverageBorrowAmount },
        tokenOut: leverageToken,
        slippage,
      });
      logics.push(apisdk.protocols.paraswapv5.newSwapTokenLogic(quotation));

      // 5. append balancer flash loan replay logic
      logics.push(flashLoanRepayLogic);

      const estimateResult = await apisdk.estimateRouterData({ chainId, account, logics });
      approvals = estimateResult.approvals;

      // 6. calc leverage times
      leverageTimes = common.formatBigUnit(leverageUSD.div(borrowCapacityUSD), 2);

      // 7. calc target position
      const targetBorrowUSD = new BigNumberJS(borrowUSD).plus(leverageBorrowUSD);
      const targetCollateralUSD = new BigNumberJS(collateralUSD).plus(leverageUSD);
      const targetBorrowCapacityUSD = new BigNumberJS(borrowCapacityUSD).plus(
        leverageUSD.times(leverageCollateral.borrowCollateralFactor)
      );
      const targetLiquidationLimit = new BigNumberJS(liquidationLimit).plus(
        leverageUSD.times(leverageCollateral.liquidateCollateralFactor)
      );
      const targetLiquidationThreshold = common.formatBigUnit(targetLiquidationLimit.div(targetCollateralUSD), 4);
      targetPosition = {
        utilization: calcUtilization(targetBorrowCapacityUSD, targetBorrowUSD),
        healthRate: calcHealthRate(targetCollateralUSD, targetBorrowUSD, targetLiquidationThreshold),
        netAPR: calcNetAPR(supplyUSD, supplyAPR, targetCollateralUSD, targetBorrowUSD, borrowAPR),
        totalDebt: common.formatBigUnit(targetBorrowUSD, 2),
      };
    }

    const responseBody: GetLeverageQuotationResponseBody = {
      quotation: { leverageTimes, currentPosition, targetPosition },
      approvals,
      logics,
    };

    return formatJSONResponse(responseBody);
  },
};
