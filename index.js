const qs = require('querystring');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const jwkToPem = require('jwk-to-pem');
const auth = require('./auth.js');
const axios = require('axios');
const AWS = require('aws-sdk');
var ddb;
const ddbTableName = 'cloudfront-nonprod-whitelist';

var config;

exports.handler = (event, context, callback) => {
  if (typeof config == 'undefined') {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  }

  ddb = new AWS.DynamoDB.DocumentClient({apiVersion: '2012-10-08', region: config.AWS_REGION});

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
        mainProcess(event, context, callback);
      }
    }
  });
};

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
  if (request.uri.startsWith(config.CALLBACK_PATH)) {
    /** Verify code is in querystring */
    if (!queryDict.code || !queryDict.state) {
      unauthorized("No code or state found.", callback);
    }
    config.TOKEN_REQUEST.code = queryDict.code;
    config.TOKEN_REQUEST.state = queryDict.state;
    /** Exchange code for authorization token */
    const postData = qs.stringify(config.TOKEN_REQUEST);
    axios.post(config.TOKEN_ENDPOINT, postData)
      .then(function(response) {
        var responseQueryString = qs.parse(response.data);
        /** Get authenticated user's login */
        if (responseQueryString.error) {
          internalServerError("Error while getting token: " + responseQueryString.error_description, callback);
        } else {
          const authorization = responseQueryString.token_type + ' ' + responseQueryString.access_token;
          axios.get('https://api.github.com/user', { headers: {'Authorization': authorization}})
            .then(function(response) {
              /** Check if authenticated user's login is a member of given org */
              if (!response.data.hasOwnProperty('login')) {
                internalServerError('Unable to find login', callback);
              }
              var username = response.data.login;
              var orgsGet = 'https://api.github.com/orgs/' + config.ORGANIZATION + '/members/' + username;
              axios.get(orgsGet, { headers: {'Authorization': authorization} })
                .then(function(response) {
                  /** Set cookie upon verified membership */
                  if (response.status == 204) {
                    const nextLocation = {
                      "status": "302",
                      "statusDescription": "Found",
                      "body": "ID token retrieved.",
                      "headers": {
                        "location" : [{
                          "key": "Location",
                          "value": queryDict.state
                        }],
                        "set-cookie" : [{
                          "key": "Set-Cookie",
                          "value" : cookie.serialize('TOKEN', jwt.sign(
                            { },
                            config.PRIVATE_KEY.trim(),
                            {
                              audience: headers.host[0].value,
                              subject: auth.getSubject(username),
                              expiresIn: config.SESSION_DURATION,
                              algorithm: 'RS256'
                            } // Options
                          ))
                        }],
                      },
                    };
                    callback(null, nextLocation);
                  } else {
                    unauthorized('Unauthorized. User ' + response.login + ' is not a member of required organization.', callback);
                  }
                })
                .catch(function(error) {
                  internalServerError('Error checking membership: ' + error.message, callback);
                });
            })
            .catch(function(error) {
              internalServerError('Error getting user: ' + error.message, callback);
            });
        }
      })
      .catch(function(error) {
        internalServerError('Error getting token: ' + error.message, callback);
      });
  } else if ("cookie" in headers
              && "TOKEN" in cookie.parse(headers["cookie"][0].value)) {
    // Verify the JWT, the payload email, and that the email ends with configured hosted domain
    jwt.verify(cookie.parse(headers["cookie"][0].value).TOKEN, config.PUBLIC_KEY.trim(), { algorithms: ['RS256'] }, function(err, decoded) {
      if (err) {
        switch (err.name) {
          case 'TokenExpiredError':
            redirect(request, headers, callback);
            break;
          case 'JsonWebTokenError':
            unauthorized(err.message, callback);
            break;
          default:
            unauthorized('Unauthorized. User ' + decoded.sub + ' is not permitted.', callback);
        }
      } else {
        addToWhitelist(request.clientIp, function() {
          auth.isAuthorized(decoded, request, callback, unauthorized, internalServerError, config);
        });
      }
    });
  } else {
    redirect(request, headers, callback);
  }
}

function redirect(request, headers, callback) {
  config.AUTH_REQUEST.state = request.uri;
  // Redirect to Authorization Server
  var querystring = qs.stringify(config.AUTH_REQUEST);

  const response = {
    status: "302",
    statusDescription: "Found",
    body: "Redirecting to OAuth2 provider",
    headers: {
      "location" : [{
        "key": "Location",
        "value": config.AUTHORIZATION_ENDPOINT + '?' + querystring
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
