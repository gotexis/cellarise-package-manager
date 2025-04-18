"use strict";
const R = require("ramda");
const fs = require('fs');
const path = require('path');
const mkdirp = require("mkdirp");
const jiraIssueManager = require("./jiraIssueManager");
const {
  getDbPrimaryConnectionString, getDbBackupConnectionString, getDbBackupSchema, deleteAllWebappDatabaseSchemaAndData
} = require("./mssqlDatabaseManager");
const msRestAzure = require("ms-rest-azure");
const ResourceManagementClient = require('azure-arm-resource').ResourceManagementClient;
const SubscriptionManagementClient = require('azure-arm-resource').SubscriptionClient;
const WebSiteManagement = require('azure-arm-website');


/**
 * Creates a new authenticated azure client.
 * This is v1: user and password.
 * V2: Use Service Principle.
 * @param {Object} context - context of repository originating the call to this task
 * @param {Function} callback - User Credentials.
 * @throws {Error} Any error that occures during authentication to Azure.
 */
const authenticateAzure = function (context, callback) {
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  msRestAzure.loginWithServicePrincipalSecret(
    azureConfig.client_id,
    azureConfig.secret,
    azureConfig.tenant_id,
    (error, credentials) => {

      if (!R.isEmpty(error) && !R.isNil(error)) {
        callback(error);
        return;
      }

      callback(null, credentials);
    });
};

/**
 * Retrieves a subscription id (if any) for provided credentials.
 * @param {Object} context - context of repository originating the call to this task
 * @param {Object} credentials - User Credentials
 * @param {Function} callback - {Object} User Credentials, {String} Subscription Id.
 * @throws {Error} If a user does not have an assigned subscription.
 */
const getSubscriptionId = function (context, credentials, callback) {
  const subscriptionClient = new SubscriptionManagementClient(credentials);

  subscriptionClient.subscriptions.list().then((res) => {
    const subscriptionId = res[0].subscriptionId;

    if (R.isNil(subscriptionId) || R.isEmpty(subscriptionId)) {
      callback("No subscriptions available for this user.");
      return;
    }

    callback(null, credentials, subscriptionId);
  });
};

/**
 * Validates if a user has access to a resource group, specified in the config file.
 * @param {Object} context - context of repository originating the call to this task
 * @param {Object} credentials - User Credentials
 * @param {String} subscriptionId - Azure subscription id
 * @param {Function} callback - {Object} User Credentials,  {String} Subscription Id
 * @throws {Error} If there no resource group has been specified in the config file.
 * @throws {Error} If a provided user is not a part of any resource group.
 * @throws {Error} If a provided user does not have permissions to access a specified group.
 */
const validateGroupAccess = function (context, credentials, subscriptionId, callback) {
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  const resourceClient = new ResourceManagementClient(credentials, subscriptionId);

  if (R.isNil(azureConfig.resource_group) || R.isEmpty(azureConfig.resource_group)) {
    callback("No resource_group has been specified in your config file.");
    return;
  }

  resourceClient.resourceGroups.list().then((groups) => {
    let groupId = null;

    if (R.isNil(groups) || R.isEmpty(groups)) {
      callback("No groups available for this user.");
      return;
    }

    groupId = groups.filter((group) => group.name === azureConfig.resource_group);

    if (R.isNil(groupId) || R.isEmpty(groupId)) {
      callback("This user doesn't have access to the specified group.");
      return;
    }

    callback(null, credentials, subscriptionId);
  });
};

/**
 * Extracts a Jira issue key from a current bamboo branch
 * and prepends a prefix, specified in the config file.
 * @param {Object} context - context of repository originating the call to this task
 * @param {Object} credentials - User Credentials
 * @param {String} subscriptionId - Azure subscription id
 * @param {Function} callback - {Object} User Credentials,  {String} Subscription Id, {String} Environment Name.
 */
const getEnvironmentName = function (context, credentials, subscriptionId, callback) {
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  const jiraIssueKey = jiraIssueManager.getJiraIssueKey(context) || "";
  const websiteName = getWebsiteName(azureConfig, jiraIssueKey);
  callback(null, credentials, subscriptionId, websiteName);
};

/**
 * Checks if an environment already exists.
 * @param {Object} context - context of repository originating the call to this task
 * @param {Object} credentials - User Credentials
 * @param {String} subscriptionId - Azure subscription id
 * @param {String} websiteName - webapp name
 * @param {Function} callback  - {Object} User Credentials,  {String} Subscription Id, {String} Environment Name,
 * {Boolean} True or False value that indicates if an environment already exists.
 */
const checkWebsiteExists = function (context, credentials, subscriptionId, websiteName, callback) {
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  const webSiteClient = new WebSiteManagement(credentials, subscriptionId);
  webSiteClient.checkNameAvailability(websiteName, azureConfig.resource_type).then(
    (res) => {
      callback(null, credentials, subscriptionId, websiteName, !res.nameAvailable);
    },
    (err) => {
      callback(err);
    }
  );
};

/**
 * Creates an Azure environment with a provided name.
 * This is V1: Template is hard-coded.
 * @param {Object} context - context of repository originating the call to this task
 * @param {Object} credentials - User Credentials
 * @param {String} subscriptionId - Azure subscription id
 * @param {String} websiteName - webapp environment name
 * @param {Function} callback - nothing
 */
const createEnvironment = function (context, credentials, subscriptionId, websiteName, callback) {
  createOrUpdateEnvironment(context, credentials, subscriptionId, websiteName, false, callback);
};
const updateEnvironment = function (context, credentials, subscriptionId, websiteName, callback) {
  createOrUpdateEnvironment(context, credentials, subscriptionId, websiteName, true, callback);
};
const createOrUpdateEnvironment = function (context, credentials, subscriptionId, websiteName, updateMode, callback) {
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  const logger = context.logger;
  const execUtils = require("../../bin/exec")(logger);
  const webSiteClient = new WebSiteManagement(credentials, subscriptionId);
  const cwd = context.cwd;
  const directories = context.package.directories;
  let azureEnvTemplate = require(path.join(cwd, directories.templates + "/azure-specs", "webapp.json"));

  if (R.isNil(azureEnvTemplate)) {
    callback("Invalid azure environment", websiteName);
    return;
  }

  //merge siteConfig
  azureEnvTemplate.location = azureConfig.webapp.location;
  azureEnvTemplate.serverFarmId = azureConfig.webapp.serverFarmId;
  azureEnvTemplate.siteConfig = R.merge(azureEnvTemplate.siteConfig, R.clone(azureConfig.webapp.siteConfig));

  azureEnvTemplate.siteConfig.connectionStrings[0].connectionString = getDbPrimaryConnectionString(context, 0);
  azureEnvTemplate.siteConfig.connectionStrings[1].connectionString = getDbPrimaryConnectionString(context, 1);
  azureEnvTemplate.siteConfig.appSettings[0].value = websiteName + ".azurewebsites.net";
  azureEnvTemplate.siteConfig.appSettings[1].value = getDbBackupSchema(context);
  azureEnvTemplate.siteConfig.appSettings[2].value = getRedisAppConnectionString(websiteName);

  webSiteClient.webApps.createOrUpdate(azureConfig.resource_group, websiteName, azureEnvTemplate)
    .then(
      () => {
        if (updateMode) {
          callback(null, websiteName);
          return;
        }
        //clone with full username and password to store credential in windows credential manager
        const repositoryPath = getWebsiteSCMURLWithUserAndPass(azureConfig, websiteName);
        execUtils.cloneFromGitNoLogging(
          repositoryPath,
          "Temp/" + websiteName,
          context.cwd,
          function cloneCb() {
            callback(null, websiteName);
          }
        );
      },
      (err) => {
        callback(err, websiteName);
      }
    );
};

/**
 * Deletes an Azure environment that matches a provided name.
 * @param {Object} context - context of repository originating the call to this task
 * @param {Object} credentials - User Credentials
 * @param {String} subscriptionId - Azure subscription id
 * @param {String} websiteName - webapp environment name
 * @param {Function} callback - nothing
 */
const deleteEnvironment = function (context, credentials, subscriptionId, websiteName, callback) {
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  const webSiteClient = new WebSiteManagement(credentials, subscriptionId);

  webSiteClient.webApps.deleteMethod(azureConfig.resource_group, websiteName, {
    "deleteMetrics": true

  }).then(() => {
      deleteAllWebappDatabaseSchemaAndData(context, callback);
    },
    (err) => {
      callback(err);
    }
  );
};

/**
 * Get the azure environment deployment url.
 * @param {Object} context - context of repository originating the call to this task
 * @returns {String} - deployment url
 */
const getDeploymentUrl = function (context) {
  const jiraIssueKey = jiraIssueManager.getJiraIssueKey(context) || "";
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  const websiteName = getWebsiteName(azureConfig, jiraIssueKey);
  return getWebsiteSCMURLWithUser(azureConfig, websiteName);
};

/**
 * Get the azure environment webapp url.
 * @param {Object} context - context of repository originating the call to this task
 * @returns {String} - webapp url
 */
const getWebappUrl = function (context) {
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  const jiraIssueKey = jiraIssueManager.getJiraIssueKey(context) || "";
  const websiteName = getWebsiteName(azureConfig, jiraIssueKey);
  return "https://" + websiteName + ".azurewebsites.net";
};


function getRedisAppConnectionString(websiteName) {
  const azureConfig = require("./config")("azure")[process.env.bamboo_azure_config_code];
  //randomly select database number between 2 and 9
  let min = 2;
  let max = 9;
  let databaseNumber = Math.floor(Math.random() * (max - min + 1)) + min;
  //if default website then assign database number 1
  if (websiteName === getWebsiteName(azureConfig, "")) {
    databaseNumber = 1;
  }
  return azureConfig.webapp.siteConfig.appSettings[2]
    .value.replace("database=9", "database=" + databaseNumber);
}


/**
 * Create a text file containing azure webapp variables for injection into bamboo build plan
 * @param {Object} context - context of repository originating the call to this task
 * @param {Function} callback - nothing
 */
const createAzureWebAppVariablesFile = function (context, callback) {
  const deploymentUrl = getDeploymentUrl(context);
  const webappUrl = getWebappUrl(context);
  const jiraIssueKey = jiraIssueManager.getJiraIssueKey(context);
  mkdirp.sync("Temp");
  fs.writeFile(
    path.join(process.cwd(), "Temp", 'azureWebappVariables.txt'),
    "deploymentUrl=" + deploymentUrl + ".git\n" +
    "webappUrl=" + webappUrl + "\n" +
    "webappPort=443" + "\n" +
    "jiraIssueKey=" + jiraIssueKey + "\n" +
    "webappDbPrimaryConnString0=" + getDbPrimaryConnectionString(context, 0) + "\n" +
    "webappDbPrimaryConnString1=" + getDbPrimaryConnectionString(context, 1) + "\n" +
    "webappDbBackupConnString0=" + getDbBackupConnectionString(context, 0) + "\n" +
    "webappDbBackupConnString1=" + getDbBackupConnectionString(context, 1) + "\n",
    'utf8',
    callback
  );
};

function getWebsiteSCMURLWithUser(azureConfig, websiteName) {
  const user = azureConfig.scm_user;
  return "https://" + user + "@" + websiteName + ".scm.azurewebsites.net:443/" + websiteName;
}

function getWebsiteSCMURLWithUserAndPass(azureConfig, websiteName) {
  const userAndPass = azureConfig.scm_user + ":" + azureConfig.scm_password;
  return "https://" + userAndPass + "@" + websiteName + ".scm.azurewebsites.net:443/" + websiteName;
}

function getWebsiteName(azureConfig, jiraIssueKey) {
  if (R.isNil(jiraIssueKey) || jiraIssueKey === "") {
    return (azureConfig.env_prefix + "-qa").toLowerCase();
  }
  return (azureConfig.env_prefix + '-' + jiraIssueKey + "-qa").toLowerCase();
}

module.exports = {
  "authenticateAzure": authenticateAzure,
  "checkWebsiteExists": checkWebsiteExists,
  "createEnvironment": createEnvironment,
  "updateEnvironment": updateEnvironment,
  "deleteEnvironment": deleteEnvironment,
  "getSubscriptionId": getSubscriptionId,
  "getEnvironmentName": getEnvironmentName,
  "validateGroupAccess": validateGroupAccess,
  "getDeploymentUrl": getDeploymentUrl,
  "getWebappUrl": getWebappUrl,
  "createAzureWebAppVariablesFile": createAzureWebAppVariablesFile
};
