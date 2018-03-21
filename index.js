const qs = require('querystring');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const jwkToPem = require('jwk-to-pem');
const auth = require('./auth.js');
const axios = require('axios');
const AWS = require('aws-sdk');
var ddb;
var ddbTableName;

var discoveryDocument;
var jwks;
var config;

exports.handler = (event, context, callback) => {

  initialize();

  // Get request and request headers
  const request = event.Records[0].cf.request;
  const headers = request.headers;

  let params = {
    TableName: ddbTableName,
    Key: {
      "ip": request.clientIp
    }
  };

  ddb.get(params, function(err, data) {
    if (err) {
      console.error("Unable to get item. Error:", JSON.stringify(err, null, 2));
      callback(null, request); // let it pass
    } else {
      if ('Item' in data) {
        // IP found in whitelist
        callback(null, request);
      } else {
        // IP not in whitelist. Require Basic authentication
        // Get Discovery Document data
        axios.get(config.DISCOVERY_DOCUMENT)
          .then(function(response) {
            // Get jwks from discovery document url
            discoveryDocument = response.data;
            if (discoveryDocument.hasOwnProperty('jwks_uri')) {
              // Get public key and verify JWT
              axios.get(discoveryDocument.jwks_uri)
                .then(function(response) {
                  jwks = response.data;
                  // Callback to main function
                  mainProcess(event, context, callback);
                })
                .catch(function(error) {
                  internalServerError(error.message, callback);
                });
            } else {
              internalServerError("Unable to find JWK in discovery document.", callback);
            }
          })
          .catch(function(error) {
            internalServerError(error.message, callback);
          });
      }
    }
  });
};

exports.handlerWhitelist = (event, context, callback) => {
  initialize();

  // Get request and request headers
  const request = event.Records[0].cf.request;

  let params = {
    TableName: ddbTableName,
    Key: {
      "ip": request.clientIp
    }
  };

  ddb.get(params, function(err, data) {
    if (err) {
      console.error("Unable to get item. Error:", JSON.stringify(err, null, 2));
      callback(null, request); // let it pass
    } else {
      if ('Item' in data) {
        // IP found in whitelist
        callback(null, request);
      } else {
        unauthorized('Go to https://www-'+config.ENV.toLowerCase()+'.amaysim.com.au and authenticate first.', callback);
      }
    }
  });

};

function initialize() {
  config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

  ddb = new AWS.DynamoDB.DocumentClient({apiVersion: '2012-10-08', region: config.DYNAMO_AWS_REGION});
  ddbTableName = 'cloudfront-whitelist-' + config.ENV;
}

function addToWhitelist(clientIp, callback) {
  let item = {
      TableName: ddbTableName,
      Item: {
          "ip": clientIp
      }
  };
  ddb.put(item, function(err, data) {
      if (err) {
          console.error("Unable to add item. Error JSON:", JSON.stringify(err, null, 2));
      } else {
          console.log("Added IP to whitelist:", JSON.stringify(data, null, 2));
      }
      callback();
  });
}

function mainProcess(event, context, callback) {
  // Get request, request headers, and querystring dictionary
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const queryDict = qs.parse(request.querystring);

  config.AUTH_REQUEST.redirect_uri = 'https://' + headers.host[0].value + config.CALLBACK_PATH;
  config.TOKEN_REQUEST.redirect_uri = 'https://' + headers.host[0].value + config.CALLBACK_PATH;

  if (request.uri.startsWith(config.CALLBACK_PATH)) {
    console.log("Callback from OIDC provider received");
    /** Verify code is in querystring */
    if (!queryDict.code) {
      unauthorized("No code found.", callback);
    }
    config.TOKEN_REQUEST.code = queryDict.code;
    /** Exchange code for authorization token */
    const postData = qs.stringify(config.TOKEN_REQUEST);
    console.log("Requesting access token.");
    axios.post(discoveryDocument.token_endpoint, postData)
      .then(function(response) {
        const decodedData = jwt.decode(response.data.id_token, {complete: true});
        try {
          console.log("Searching for JWK from discovery document");
          // Search for correct JWK from discovery document and create PEM
          var pem = "";
          for (var i = 0; i < jwks.keys.length; i++) {
            if (decodedData.header.kid === jwks.keys[i].kid) {
              pem = jwkToPem(jwks.keys[i]);
            }
          }
          console.log("Verifying JWT");
          // Verify the JWT, the payload email, and that the email ends with configured hosted domain
          jwt.verify(response.data.id_token, pem, { algorithms: ['RS256'] }, function(err, decoded) {
            if (err) {
              switch (err.name) {
                case 'TokenExpiredError':
                  console.log("Token expired, redirecting to OIDC provider.");
                  redirect(request, headers, callback)
                  break;
                case 'JsonWebTokenError':
                  console.log("JWT error, unauthorized.");
                  unauthorized('JsonWebTokenError: ' + err.message, callback);
                  break;
                default:
                  console.log("Unknown JWT error, unauthorized.");
                  unauthorized('Unauthorized. User ' + decodedData.payload.email + ' is not permitted.', callback);
              }
            } else {
              console.log("Setting cookie and redirecting.");
              // Once verified, create new JWT for this server
              const response = {
                "status": "302",
                "statusDescription": "Found",
                "body": "ID token retrieved.",
                "headers": {
                  "location" : [{
                    "key": "Location",
                    "value": event.Records[0].cf.config.hasOwnProperty('test') ? (config.AUTH_REQUEST.redirect_uri + queryDict.state) : queryDict.state
                  }],
                  "set-cookie" : [{
                    "key": "Set-Cookie",
                    "value" : cookie.serialize('TOKEN', jwt.sign(
                      { },
                      config.PRIVATE_KEY.trim(),
                      {
                        "audience": headers.host[0].value,
                        "subject": auth.getSubject(decodedData),
                        "expiresIn": config.SESSION_DURATION,
                        "algorithm": "RS256"
                      } // Options
                    ))
                  }],
                },
              };
              callback(null, response);
            }
          });
        } catch (error) {
          internalServerError(error.message, callback);
        }
      })
      .catch(function(error) {
        internalServerError(error.message, callback);
      });
  } else if ("cookie" in headers
              && "TOKEN" in cookie.parse(headers["cookie"][0].value)) {
    console.log("Request received with TOKEN cookie. Validating.");
    // Verify the JWT, the payload email, and that the email ends with configured hosted domain
    jwt.verify(cookie.parse(headers["cookie"][0].value).TOKEN, config.PUBLIC_KEY.trim(), { algorithms: ['RS256'] }, function(err, decoded) {
      if (err) {
        switch (err.name) {
          case 'TokenExpiredError':
            console.log("Token expired, redirecting to OIDC provider.");
            redirect(request, headers, callback)
            break;
          case 'JsonWebTokenError':
            console.log("JWT error, unauthorized.");
            unauthorized(err.message, callback);
            break;
          default:
            console.log("Unknown JWT error, unauthorized.");
            unauthorized('Unauthorized. User ' + decoded.sub + ' is not permitted.', callback);
        }
      } else {
        console.log("Authorizing user.");
        addToWhitelist(request.clientIp, function() {
          auth.isAuthorized(decoded, request, callback, unauthorized, internalServerError, config);
        });
      }
    });
  } else {
    console.log("Redirecting to OIDC provider.");
    redirect(request, headers, callback);
  }
}

function redirect(request, headers, callback) {
  var n = require('nonce')();
  config.AUTH_REQUEST.nonce = n();
  config.AUTH_REQUEST.state = request.uri;
  // Redirect to Authorization Server
  var querystring = qs.stringify(config.AUTH_REQUEST);

  const response = {
    "status": "302",
    "statusDescription": "Found",
    "body": "Redirecting to OIDC provider",
    "headers": {
        "location" : [{
            "key": "Location",
            "value": discoveryDocument.authorization_endpoint + '?' + querystring
         }],
         "set-cookie" : [{
           "key": "Set-Cookie",
           "value" : cookie.serialize('TOKEN', '', { path: '/', expires: new Date(1970, 1, 1, 0, 0, 0, 0) })
         }],
    },
  };
  callback(null, response);
}

function unauthorized(body, callback) {
  const response = {
    "status": "401",
    "statusDescription": "Unauthorized",
    "body": body,
    "headers": {
       "set-cookie" : [{
         "key": "Set-Cookie",
         "value" : cookie.serialize('TOKEN', '', { path: '/', expires: new Date(1970, 1, 1, 0, 0, 0, 0) })
       }],
    },
  };
  callback(null, response);
}

function internalServerError(body, callback) {
  const response = {
    "status": "500",
    "statusDescription": "Internal Server Error",
    "body": body,
  };
  callback(null, response);
}
