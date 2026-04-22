/**
 * OAuth types for Claude Code
 * 
 * This module exports all type definitions used in the OAuth flow.
 */

/**
 * The type of subscription a user has
 */
export type SubscriptionType = 
  | 'max'
  | 'pro'
  | 'enterprise'
  | 'team'
  | null

/**
 * The rate limit tier for the user
 */
export type RateLimitTier = 
  | 'default_claude_max_5x'
  | 'default_claude_pro_25x'
  | 'default_claude_api'
  | null

/**
 * The type of billing for the user
 */
export type BillingType = 
  | 'stripe_subscription'
  | 'stripe_subscription_contracted'
  | 'apple_subscription'
  | 'google_play_subscription'
  | null

/**
 * OAuth token exchange response from the server
 */
export type OAuthTokenExchangeResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
  account?: {
    uuid: string
    email_address: string
  }
}

/**
 * OAuth tokens stored after successful authentication
 */
export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

/**
 * OAuth profile response from the server
 */
export type OAuthProfileResponse = {
  account: {
    uuid: string
    email: string
    display_name?: string
    created_at?: string
  }
  organization: {
    uuid: string
    name: string
    organization_type?: string
    organization_role?: string
    workspace_role?: string
    organization_name?: string
    rate_limit_tier?: string
    has_extra_usage_enabled?: boolean
    billing_type?: string
    subscription_created_at?: string
  }
}

/**
 * User roles response from the server
 */
export type UserRolesResponse = {
  organization_role: string
  workspace_role: string
  organization_name: string
}