const axios = require('axios')
const influx = require('influx')
const dotenv = require('dotenv')
const config = require('./config.json')
dotenv.config()

const tokenRequestHeaders = {
  'Content-Type': 'application/json',
  'X-UIPATH-TenantName': process.env.ORC_TENANT_LOGICAL_NAME
}

const tokenRequestData = {
  grant_type: 'refresh_token',
  client_id: process.env.ORC_CLIENT_ID,
  refresh_token: process.env.ORC_USER_KEY
}

const apiBaseUrl = 'https://platform.uipath.com/' + process.env.ORC_ACCOUNT_LOGICAL_NAME + '/' + process.env.ORC_TENANT_LOGICAL_NAME

// Intercepts unauthorized requests and performs auth token renewal
axios.interceptors.response.use((response) => {
  return response
}, error => {
  const originalRequest = error.config
  if (error.response.status === 401) {
    console.log('OAuth token expired. Renewing...')
    return axios({
      method: 'post',
      url: config.orchestrator.tokenRequestURL,
      data: tokenRequestData,
      headers: tokenRequestHeaders
    })
      .then(response => {
        // Retries failed requests with renewed auth token
        const token = response.data.access_token
        axios.defaults.headers.common = { Authorization: `Bearer ${token}`, 'X-UIPATH-TenantName': process.env.ORC_TENANT_LOGICAL_NAME }
        return axios(originalRequest)
      })
      .catch(error => { console.log(error) })
  }
  return Promise.reject(error)
})

async function getRunningJobs () {
  return new Promise((resolve, reject) => {
    try {
      console.log('Checking for running jobs.')
      let influxRunningJobs = []
      const processRequests = []
      // Gets Host Machine Name and Release Name of Jobs with State = Running
      const getJobsEndpoint = '/odata/Jobs?$filter=State%20eq%20\'Running\'&$select=ReleaseName%2C%20HostMachineName'
      axios({
        method: 'get',
        url: apiBaseUrl + getJobsEndpoint
      })
        .then(response => {
          if (response.data.value.length === 0) {
            console.log('No running jobs found.')
            resolve(influxRunningJobs)
          } else {
            // Builds array of Host Machine Name data points in JSON format.
            influxRunningJobs = (response.data.value).map(obj => {
              return {
                measurement: config.influxdb.database.vmMeasurementLabel,
                tags: {
                  machineName: obj.HostMachineName
                },
                fields: {
                  // Strings must be double quoted per Influx DB 'field' specification
                  status: `"${config.influxdb.database.vmFieldValue}"`
                }
              }
            })
            // Uses Release Name to build array of API calls that return Process Name
            // #GET /odata/Releases with {filter : Name eq ReleaseName } and {select : ProcessKey}
            for (const i in response.data.value) {
              const releaseName = response.data.value[i].ReleaseName
              const getProcessEndpoint = `/odata/Releases?$filter=Name%20eq%20'${releaseName}'&$select=ProcessKey`
              // Construct all runningProcess query promises
              const getProcess = axios({
                method: 'get',
                url: apiBaseUrl + getProcessEndpoint
              })
              processRequests.push(getProcess)
            }
            axios
              .all(processRequests)
              .then(axios.spread((...responses) => {
                for (let i = 0; i < responses.length; i++) {
                  const processName = responses[i].data.value[0].ProcessKey
                  // Inserts Process Names against array of Running Jobs data points
                  influxRunningJobs[i].tags.process = processName
                }
                console.log('Running jobs received.')
                resolve(influxRunningJobs)
              }))
          }
        })
    } catch (error) { console.log(error) }
  })
}
// Getting licenses requires a separate request per robot type
// #GET /odata/LicensesNamedUser with {filter : IsLicensed eq true} and {select : UserName}
async function getActiveLicenses () {
  return new Promise((resolve, reject) => {
    try {
      console.log('Checking for active licenses.')
      let influxActiveLicenses = []
      const licenseRequests = []
      for (const i in config.orchestrator.robotType) {
        const robotType = config.orchestrator.robotType[i]
        const licensesEndpoint = `/odata/LicensesNamedUser/UiPath.Server.Configuration.OData.GetLicensesNamedUser(robotType='${robotType}')?$filter=IsLicensed%20eq%20true%20`
        const getLicense = axios({
          method: 'get',
          url: apiBaseUrl + licensesEndpoint
        })
        licenseRequests.push(getLicense)
      }
      axios
        .all(licenseRequests)
        .then(axios.spread((...responses) => {
          for (let i = 0; i < responses.length; i++) {
            if ((responses[i].data.value).length === 0) {
              continue
            }
            // Builds array of Active License data points in JSON format.
            influxActiveLicenses = influxActiveLicenses.concat((responses[i].data.value).map(obj => {
              return {
                measurement: config.influxdb.database.licenseMeasurementLabel,
                tags: {
                  userName: obj.UserName
                },
                fields: {
                  license: config.influxdb.database.LicenseFieldValue
                }
              }
            }))
          }
          console.log('Active licenses received.')
          resolve(influxActiveLicenses)
        }))
    } catch (error) { console.log(error) }
  })
}

// InfluxDB connection
const influxConnection = new influx.InfluxDB({
  database: process.env.INFLUX_DB_NAME,
  host: process.env.INFLUX_HOST,
  port: process.env.INFLUX_PORT,
  username: process.env.INFLUX_USERNAME,
  password: process.env.INFLUX_PASSORD
})

// Polling on a user configured interval, running both requests concurrently until both are complete
async function Main () {
  const pollingInterval = process.env.POLLING_INTERVAL // In Milliseconds
  const results = await Promise.all([getRunningJobs(), getActiveLicenses()])
  const influxData = [...results[0], ...results[1]]
  // Write data to InfluxDB
  console.log('Writing to InfluxDB:', influxData)
  influxConnection.writePoints((influxData), {
    database: process.env.INFLUX_DB_NAME,
    precision: 's'
  })
    .catch(error => { console.log(`Error saving data to InfluxDB: ${error.stack}`) })
  setTimeout(Main, pollingInterval)
}

Main()
