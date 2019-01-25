const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  saveFiles
} = require('cozy-konnector-libs')
const jwt = require('jwt-decode')
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})

const baseUrl = 'https://alan.eu'
const apiUrl = 'https://api.alan.eu'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  const user = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  const data = await request(
    `${apiUrl}/api/users/${
      user.userId
    }?expand=beneficiaries.insurance_profile.legacy_coverages,beneficiaries.insurance_profile.settlements,beneficiaries.insurance_profile.teletransmission_status_to_display,beneficiaries.insurance_profile.user.current_settlement_iban,invoices,insurance_profile,address,current_billing_iban,current_settlement_iban,current_exemption.company.current_contract.current_prevoyance_contract.prevoyance_plan,company.current_contract.current_prevoyance_contract.prevoyance_plan,company.current_contract.current_plan,company.current_contract.discounts,insurance_profile.current_policy.contract.current_plan,insurance_profile.current_policy.contract.contractee,legacy_health_contract,current_contract.madelin_attestations,current_contract.amendments,current_contract.current_plan,accountant,insurance_documents,insurance_documents.quotes,authorized_billing_ibans`,
    {
      auth: {
        bearer: user.token
      }
    }
  )

  const policyId = data.insurance_profile.current_policy.id
  await saveFiles(
    [
      {
        fileurl: `${apiUrl}/api/policies/tp-card/${policyId}?t=${Date.now()}`,
        filename: 'Carte_Mutuelle.pdf',
        requestOptions: {
          auth: {
            bearer: user.token
          }
        }
      }
    ],
    fields
  )
}

async function authenticate(email, password) {
  await request(`${baseUrl}/login`)
  try {
    const resp = await request.post(`${apiUrl}/auth/login`, {
      body: { email, password, refresh_token_type: 'web' }
    })
    resp.userId = jwt(resp.token).id
    return resp
  } catch (err) {
    log('error', err.message)
    throw new Error(errors.LOGIN_FAILED)
  }
}
