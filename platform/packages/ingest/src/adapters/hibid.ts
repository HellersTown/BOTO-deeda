// HiBid adapter — draft: query constants only (rewritten in full below).

export const LOT_SEARCH_QUERY = `query LotSearch($pageNumber: Int!, $pageLength: Int!, $state: String = null, $status: AuctionLotStatus = null, $sortOrder: EventItemSortOrder = null, $auctionId: Int = null, $countAsView: Boolean = false) {
  lotSearch(input: {state: $state, status: $status, sortOrder: $sortOrder, auctionId: $auctionId, countAsView: $countAsView}, pageNumber: $pageNumber, pageLength: $pageLength, sortDirection: ASC) {
    pagedResults {
      pageLength pageNumber totalCount filteredCount
      results {
        id itemId lotNumber lead description quantity estimate pictureCount shippingOffered
        featuredPicture { fullSizeLocation }
        lotState { bidCount highBid minBid status timeLeftSeconds timeLeftTitle isClosed isHidden reserveSatisfied showReserveStatus priceRealized softCloseMinutes biddingExtended buyNow }
        auction { id eventName eventCity eventState eventZip bidType bidCloseDateTime auctioneer { id name state } }
      }
    }
  }
}`;

export const AUCTION_SEARCH_QUERY = `query AuctionSearch($pageNumber: Int!, $pageLength: Int!, $state: String = null, $status: AuctionLotStatus = null) {
  auctionSearch(input: {state: $state, status: $status}, pageNumber: $pageNumber, pageLength: $pageLength) {
    pagedResults {
      pageLength pageNumber totalCount filteredCount
      results {
        auction {
          id eventName description eventCity eventState eventZip eventAddress
          bidOpenDateTime bidCloseDateTime eventDateBegin eventDateEnd eventDateInfo previewDateInfo checkoutDateInfo
          bidType sourceType lotCount currencyAbbreviation
          buyerPremium buyerPremiumRate showBuyerPremium termsAndConditions shippingAndPickupInfo
          auctionState { auctionStatus openLotCount }
          auctioneer { id name address city state postalCode phone internetAddress }
        }
      }
    }
  }
}`;

/** Collapse whitespace so the request body is compact and byte-stable. */
export function compactQuery(q: string): string {
  return q.replace(/\s+/g, ' ').trim();
}

export interface LotSearchVars {
  pageNumber: number;
  pageLength: number;
  state?: string | null;
  status?: string | null;
  sortOrder?: string | null;
  auctionId?: number | null;
}

export function lotSearchBody(v: LotSearchVars): string {
  return JSON.stringify({
    operationName: 'LotSearch',
    variables: {
      pageNumber: v.pageNumber,
      pageLength: v.pageLength,
      state: v.state ?? null,
      status: v.status ?? null,
      sortOrder: v.sortOrder ?? null,
      auctionId: v.auctionId ?? null,
      countAsView: false,
    },
    query: compactQuery(LOT_SEARCH_QUERY),
  });
}

export interface AuctionSearchVars {
  pageNumber: number;
  pageLength: number;
  state?: string | null;
  status?: string | null;
}

export function auctionSearchBody(v: AuctionSearchVars): string {
  return JSON.stringify({
    operationName: 'AuctionSearch',
    variables: {
      pageNumber: v.pageNumber,
      pageLength: v.pageLength,
      state: v.state ?? null,
      status: v.status ?? null,
    },
    query: compactQuery(AUCTION_SEARCH_QUERY),
  });
}
