const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  saveFiles,
  saveBills
} = require('cozy-konnector-libs')
const jwt = require('jwt-decode')
const moment = require('moment')
const groupBy = require('lodash/groupBy')
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

  const { beneficiaries, insurance_profile } = await request(
    `${apiUrl}/api/users/${
      user.userId
    }?expand=beneficiaries.insurance_profile.legacy_coverages,beneficiaries.insurance_profile.settlements,beneficiaries.insurance_profile.teletransmission_status_to_display,beneficiaries.insurance_profile.user.current_settlement_iban,invoices,insurance_profile,address,current_billing_iban,current_settlement_iban,current_exemption.company.current_contract.current_prevoyance_contract.prevoyance_plan,company.current_contract.current_prevoyance_contract.prevoyance_plan,company.current_contract.current_plan,company.current_contract.discounts,insurance_profile.current_policy.contract.current_plan,insurance_profile.current_policy.contract.contractee,legacy_health_contract,current_contract.madelin_attestations,current_contract.amendments,current_contract.current_plan,accountant,insurance_documents,insurance_documents.quotes,authorized_billing_ibans`,
    {
      auth: {
        bearer: user.token
      }
    }
  )

  let bills = []
  for (const beneficiary of beneficiaries) {
    const name = beneficiary.insurance_profile.user.normalized_full_name
    bills.push.apply(
      bills,
      beneficiary.insurance_profile.settlements
        .filter(bill => bill.reimbursement_status === 'processed')
        .map(bill => ({
          vendor: 'alan',
          beneficiary: name,
          type: 'health_costs',
          date: moment(bill.payment_date, 'YYYY-MM-DD').toDate(),
          originalDate: moment(bill.care_date, 'YYYY-MM-DD').toDate(),
          subtype: bill.displayed_label,
          description: bill.care_type_desc,
          socialSecurityRefund: bill.ss_amount / 100,
          amount: bill.covered_amount / 100,
          originalAmount: bill.total_amount / 100,
          isThirdPartyPayer: bill.origin === 'tiers_payant',
          currency: '€',
          isRefund: true,
          metadata: {
            importDate: new Date(),
            version: 1
          }
        }))
    )
  }

  // find groupAmounts by date
  const groupedBills = groupBy(bills, 'date')
  bills = bills.map(bill => {
    if (bill.isThirdPartyPayer) return bill
    const groupAmount = groupedBills[bill.date]
      .filter(bill => !bill.isThirdPartyPayer)
      .reduce((memo, bill) => memo + bill.amount, 0)
    if (groupAmount > 0 && groupAmount !== bill.amount)
      bill.groupAmount = groupAmount
    return bill
  })

  // add files
  let currentMonthIsReplaced = false
  bills = bills.map(bill => {
    bill.fileurl = `https://api.alan.eu/api/users/${
      user.userId
    }/settlements?year=${moment(bill.date).format('YYYY')}&month=${moment(bill.date).format(
      'M'
    )}`
    bill.filename = `${moment(bill.date).format('YYYY_MM')}_alan.pdf`
    const currentMonth = moment().format('M')
    bill.shouldReplaceFile = doc => {
      const isCurrentMonth = moment(doc.date).format('M') === currentMonth
      // replace current month file only one time
      if (isCurrentMonth && !currentMonthIsReplaced) {
        currentMonthIsReplaced = true
      }
      return !currentMonthIsReplaced
    }
    bill.requestOptions = {
      auth: {
        bearer: user.token
      }
    }
    return bill
  })

  await saveBills(bills, fields.folderPath, {
    identifiers: ['alan']
  })

  const policyId = insurance_profile.current_policy.id
  await saveFiles(
    [
      {
        fileurl: `${apiUrl}/api/policies/tp-card/${policyId}?t=${Date.now()}`,
        filename: 'Carte_Mutuelle.pdf',
        shouldReplaceFile: () => true,
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
