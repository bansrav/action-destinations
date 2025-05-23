import { getAuthToken, sendEventsRequest, handleAmazonApiError } from '../utils'
import nock from 'nock'
import { IntegrationError, RequestClient } from '@segment/actions-core'
import { ConversionTypeV2, EventData } from '../types'

describe('Amazon Conversions API Utils', () => {
  beforeEach(() => {
    nock.cleanAll()
  })

  describe('getAuthToken', () => {
    it('should successfully refresh access token', async () => {
      const mockAccessToken = 'new-access-token-123'
      const auth = { refreshToken: 'test-refresh-token', accessToken: 'old-token' }

      nock('https://api.amazon.com')
        .post('/auth/o2/token')
        .reply(200, { access_token: mockAccessToken })

      // Create mock request function that returns the expected response
      const mockRequest = jest.fn().mockResolvedValue({
        data: { access_token: mockAccessToken }
      })

      const token = await getAuthToken(mockRequest as RequestClient, auth)
      expect(token).toBe(mockAccessToken)
      
      // Verify the request was made with correct parameters
      expect(mockRequest).toHaveBeenCalled()
      expect(mockRequest.mock.calls[0][0]).toBe('https://api.amazon.com/auth/o2/token')
      
      // Safe access to call arguments
      const callArg1 = mockRequest.mock.calls[0][1]
      expect(callArg1).toBeDefined()
      expect(callArg1.method).toBe('POST')
      expect(callArg1.headers).toBeDefined()
      expect(callArg1.headers.authorization).toBe('')
      
      // Safely check URLSearchParams
      expect(callArg1.body).toBeInstanceOf(URLSearchParams)
      const bodyParams = callArg1.body.toString()
      expect(bodyParams).toContain('grant_type=refresh_token')
      expect(bodyParams).toContain(`refresh_token=${auth.refreshToken}`)
    })

    it('should throw an error when the refresh token request fails', async () => {
      const auth = { refreshToken: 'test-refresh-token', accessToken: 'old-token' }

      // Create mock request function that throws an error
      const mockRequest = jest.fn().mockRejectedValue({
        message: 'Invalid refresh token'
      })

      await expect(getAuthToken(mockRequest as RequestClient, auth)).rejects.toThrow('Failed to refresh access token: Invalid refresh token')
    })

    it('should handle missing environment variables', async () => {
      // Save original env vars
      const originalClientId = process.env.ACTIONS_AMAZON_CONVERSIONS_API_CLIENT_ID
      const originalClientSecret = process.env.ACTIONS_AMAZON_CONVERSIONS_API_CLIENT_SECRET
      
      try {
        // Remove env vars to test handling of missing values
        delete process.env.ACTIONS_AMAZON_CONVERSIONS_API_CLIENT_ID
        delete process.env.ACTIONS_AMAZON_CONVERSIONS_API_CLIENT_SECRET
        
        const auth = { refreshToken: 'test-refresh-token', accessToken: 'old-token' }
        
        // Create mock request function with successful response
        const mockRequest = jest.fn().mockResolvedValue({
          data: { access_token: 'new-token' }
        })

        await getAuthToken(mockRequest as RequestClient, auth)
        
        // Check that request was called
        expect(mockRequest).toHaveBeenCalled()
        
        // Safely check call arguments
        const callArg1 = mockRequest.mock.calls[0][1]
        expect(callArg1).toBeDefined()
        expect(callArg1.body).toBeInstanceOf(URLSearchParams)
        
        // Check URLSearchParams content
        const bodyParams = callArg1.body.toString()
        expect(bodyParams).toContain('client_id=')
        expect(bodyParams).toContain('client_secret=')
      } finally {
        // Ensure env vars are always restored
        process.env.ACTIONS_AMAZON_CONVERSIONS_API_CLIENT_ID = originalClientId
        process.env.ACTIONS_AMAZON_CONVERSIONS_API_CLIENT_SECRET = originalClientSecret
      }
    })
  })

  describe('sendEventsRequest', () => {
    it('should send events request with proper format', async () => {
      const mockRegion = 'https://advertising-api.amazon.com'
      const settings = {
        region: mockRegion,
        advertiserId: 'test-advertiser-id'
      }
      
      const eventData: EventData = {
        name: 'Test Event',
        eventType: ConversionTypeV2.PAGE_VIEW,
        eventActionSource: 'WEBSITE',
        countryCode: 'US',
        timestamp: '2023-01-01T12:00:00Z'
      }

      nock(mockRegion)
        .post('/events/v1')
        .reply(200, { success: true })

      // Create mock request function
      const mockRequest = jest.fn().mockResolvedValue({
        status: 200,
        data: { success: true }
      })

      const response = await sendEventsRequest(mockRequest as RequestClient, settings, eventData)
      
      // Verify the request was made with correct parameters
      expect(mockRequest).toHaveBeenCalled()
      expect(mockRequest.mock.calls[0][0]).toBe(`${mockRegion}/events/v1`)
      
      const options = mockRequest.mock.calls[0][1]
      expect(options.method).toBe('POST')
      expect(options.json).toEqual({
        eventData: [eventData],
        ingestionMethod: 'SERVER_TO_SERVER'
      })
      expect(options.headers).toEqual({
        'Amazon-Ads-AccountId': settings.advertiserId
      })
      expect(options.timeout).toBe(25000)
      expect(options.throwHttpErrors).toBe(false)
      
      // Verify the response is returned correctly
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ success: true })
    })
    
    it('should handle multiple events in a batch', async () => {
      const mockRegion = 'https://advertising-api.amazon.com'
      const settings = {
        region: mockRegion,
        advertiserId: 'test-advertiser-id'
      }
      
      const eventDataBatch: EventData[] = [
        {
          name: 'Test Event 1',
          eventType: ConversionTypeV2.PAGE_VIEW,
          eventActionSource: 'WEBSITE',
          countryCode: 'US',
          timestamp: '2023-01-01T12:00:00Z'
        },
        {
          name: 'Test Event 2',
          eventType: ConversionTypeV2.SEARCH,
          eventActionSource: 'WEBSITE',
          countryCode: 'US',
          timestamp: '2023-01-01T12:01:00Z'
        }
      ]

      // Create mock request function
      const mockRequest = jest.fn().mockResolvedValue({
        status: 207,
        data: { success: true }
      })

      await sendEventsRequest(mockRequest as RequestClient, settings, eventDataBatch)
      
      // Verify batch was sent correctly
      expect(mockRequest).toHaveBeenCalled()
      const options = mockRequest.mock.calls[0][1]
      expect(options.json.eventData).toEqual(eventDataBatch)
      expect(options.json.eventData.length).toBe(2)
    })
  })

  describe('handleAmazonApiError', () => {
    it('should handle 401 authentication error', () => {
      const response = {
        status: 401,
        data: { message: 'Invalid credentials' }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain('Authentication failed')
      expect(error.code).toBe('AMAZON_AUTH_ERROR')
      expect(error.status).toBe(401)
    })
    
    it('should handle 403 forbidden error', () => {
      const response = {
        status: 403,
        data: { message: 'Access denied' }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain('You do not have permission')
      expect(error.code).toBe('AMAZON_FORBIDDEN_ERROR')
      expect(error.status).toBe(403)
    })
    
    it('should handle 415 media type error', () => {
      const response = {
        status: 415,
        data: { message: 'Unsupported media type' }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain('Invalid media type')
      expect(error.code).toBe('AMAZON_MEDIA_TYPE_ERROR')
      expect(error.status).toBe(415)
    })
    
    it('should handle 429 rate limit error with retry header', () => {
      const response = {
        status: 429,
        data: { message: 'Too many requests' },
        headers: { 'retry-after': '30' }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain('Rate limited by Amazon API')
      expect(error.message).toContain('Try again after 30 seconds')
      expect(error.code).toBe('AMAZON_RATE_LIMIT_ERROR')
      expect(error.status).toBe(429)
    })
    
    it('should handle 429 rate limit error without retry header', () => {
      const response = {
        status: 429,
        data: { message: 'Too many requests' }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain('Rate limited by Amazon API')
      expect(error.message).toContain('Please try again later')
      expect(error.code).toBe('AMAZON_RATE_LIMIT_ERROR')
      expect(error.status).toBe(429)
    })
    
    it('should handle 500 server error', () => {
      const response = {
        status: 500,
        data: { message: 'Internal server error' }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain('internal server error')
      expect(error.code).toBe('AMAZON_SERVER_ERROR')
      expect(error.status).toBe(500)
    })
    
    it('should handle 400 bad request error', () => {
      const response = {
        status: 400,
        data: { message: 'Invalid parameter: eventType' }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain('Failed to send event to Amazon')
      expect(error.message).toContain('Invalid parameter: eventType')
      expect(error.code).toBe('AMAZON_API_ERROR')
      expect(error.status).toBe(400)
    })
    
    it('should handle unknown error with status code', () => {
      const response = {
        status: 418,
        data: { message: "I'm a teapot" }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain("Failed to send event to Amazon: I'm a teapot")
      expect(error.code).toBe('AMAZON_API_ERROR')
      expect(error.status).toBe(418)
    })
    
    it('should handle unknown error without status code', () => {
      const response = {
        data: { message: 'Unknown error' }
      }
      
      const error = handleAmazonApiError(response)
      
      expect(error).toBeInstanceOf(IntegrationError)
      expect(error.message).toContain('Failed to send event to Amazon: Unknown error')
      expect(error.code).toBe('AMAZON_API_ERROR')
      expect(error.status).toBe(400) // Default to 400
    })
  })
})
