# CloudFront Auth Whitelist

A self-service utility for whitelisting IP addresses, based on https://github.com/Widen/cloudfront-auth.

## Overview

This solution relies on Lambda@Edge attached to a CloudFront distribution which provides authentication to an incoming request. Upon receiving a request, the Lambda@Edge checks a DynamoDB table to see if an IP address is already whitelisted.

If the IP address is not already whitelisted, the user is prompted to authenticate. Authentication is provided using an oauth2 provider such as Azure Active Directory. 

Once the user has succesfully authenticated, their IP address is added to the DynamoDB table. After a period of time, this whitelist entry is expired from the table.

## Why?

This solution enables an additional layer of authentication for sensitive systems. It also does so without interfering with systems that may not be able to handle oauth2 authentication, e.g. pre-existing system tests.

However, this is not intended to be a full authentication layer; as once an IP is whitelisted, no further authentication is required. This could include coffee shops, libraries or carrier-grade NAT. Therefore, this should not be used as the sole layer of protection on sensitive systems.

## Performance

The Lambda@Edge function adds between 800 and 2000ms additional latency depending on warm/cold starts, less if the IP is already whitelisted.

## Expiration

Expiration is enabled via the native TTL feature in DynamoDB. On successful authentication, the item created has an attribution called `expiration`. This attribute contains a [Unix epoch] timestamp of when the whitelisted IP is to be removed. When that date is removed, DynamoDB will expire that item.

[Unix epoch]: https://en.wikipedia.org/wiki/Unix_time

## Usage

This Lambda@Edge is deployed using the Serverless framework. Currently there is a branch for Github and Azure Active Directory.

To work with CloudFront, the function must be deployed to us-east-1, and it must be versioned.

Fill out the `.env` file using the [.env.template](.env.template) file provided, and then `make deploy` to invoke Serverless.

A Lambda ARN will be output, which can be then be used in a CacheBehaviour in a CloudFront distribution to enable authentication. For example:

```
Resources:
  CloudFrontDistribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        CacheBehaviors:
          - PathPattern: '/my-protected-path'
            LambdaFunctionAssociations:
              - EventType: viewer-request
                LambdaFunctionARN: <ARN output here>
```
