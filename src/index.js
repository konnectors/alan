process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://5642dd9ef4654b778964df826b0f10f4@errors.cozycloud.cc/22'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  utils,
  cozyClient
} = require('cozy-konnector-libs')
const jwt = require('jwt-decode')
const moment = require('moment')
const groupBy = require('lodash/groupBy')

const models = cozyClient.new.models
const { Qualification } = models.document

const request = requestFactory({
  debug: false,
  cheerio: false,
  json: true,
  jar: true
})

const baseUrl = 'https://alan.eu'
const apiUrl = 'https://api.alan.com'

module.exports = new BaseKonnector(start)

async function start(fields) {
  const user = await authenticate.bind(this)(fields.login, fields.password)

  let { bills, tpCardIdentifier } = await fetchData(user)
  computeGroupAmounts(bills)
  linkFiles(bills, user)
  await this.saveBills(bills, fields.folderPath, {
    identifiers: ['alan'],
    keys: ['vendorRef', 'beneficiary', 'date'],
    // Here we are using filename for deduplication for matching old version
    fileIdAttributes: ['filename'],
    sourceAccountIdentifier: fields.login,
    shouldUpdate: (
      entry,
      dbEntry // fixes wrong values due to version 2.6.0-beta.1
    ) =>
      entry.amount !== dbEntry.amount ||
      entry.isThirdPartyPayer !== dbEntry.isThirdPartyPayer ||
      entry.originalAmount !== dbEntry.originalAmount
  })

  await this.saveFiles(
    [
      {
        fileurl: `${apiUrl}/api/users/${tpCardIdentifier}/tp-card?t=${Date.now()}`,
        filename: 'Carte_Mutuelle.pdf',
        fileAttributes: {
          metadata: {
            contentAuthor: 'alan.com',
            datetime: utils.formatDate(new Date()),
            datetimeLabel: `issueDate`,
            isSubscription: false,
            carbonCopy: true,
            qualification: Qualification.getByLabel('health_insurance_card')
          }
        },
        shouldReplaceFile: () => true,
        requestOptions: {
          auth: {
            bearer: user.token
          }
        }
      }
    ],
    fields,
    {
      contentType: true,
      fileIdAttributes: ['filename']
    }
  )
}

async function fetchData(user) {
  log('debug', user.userId ? 'userId detected' : 'no userId detected')
  const { beneficiaries, tp_card_identifier } = await request(
    `${apiUrl}/api/users/${user.userId}?expand=address,admined_companies,beneficiaries.insurance_profile.legacy_coverages,beneficiaries.insurance_profile.teletransmission_status_to_display,beneficiaries.insurance_profile.user.current_settlement_iban,beneficiaries.insurance_profile.current_attestation,beneficiaries.insurance_profile.internalised_teletransmission_statuses_by_ssn,beneficiaries.insurance_profile.internalisation_switch_date,beneficiaries.insurance_profile.latest_tp_card,current_contract.amendments,current_contract.current_amendment,current_exemption,current_exemption.current_justification,current_plan,current_plan.price_rules,current_plan.health_coverage.rendered_guarantees_with_updated_emojis,insurance_profile.current_policy.contract,insurance_profile.current_policy.pec_requests,insurance_profile.current_policy.tp_card_coverages,insurance_profile.current_policy.option_contract,insurance_profile.latest_tp_card,insurance_profile,legacy_health_contract,visible_notifications,feedback`,
    {
      auth: {
        bearer: user.token
      }
    }
  )

  const decomptes = await request(
    `${apiUrl}/api/users/${user.userId}?expand=visible_insurance_documents`,
    {
      auth: {
        bearer: user.token
      }
    }
  )
  const documents = decomptes.visible_insurance_documents
  log(
    'debug',
    documents ? `There is ${documents.length} docs` : 'no documents founded'
  )

  // Send the request with the account owner's beneficiary_insurance_profile_id
  const events = await request(
    `${apiUrl}/api/insurance_profiles/${beneficiaries[0].insurance_profile.id}/care_events_public`,
    {
      auth: {
        bearer: user.token
      }
    }
  )

  // With the response, we extract the datas and prepare an array to give to saveBills
  let bills = []
  for (const beneficiary of beneficiaries) {
    const name = beneficiary.insurance_profile.user.normalized_full_name
    bills.push.apply(
      bills,
      events
        .filter(bill => bill.status === 'refunded')
        .map(bill => ({
          vendor: 'alan',
          vendorRef: bill.id,
          beneficiary: name,
          type: 'health_costs',
          date: moment(bill.estimated_payment_date, 'YYYY-MM-DD').toDate(),
          originalDate: moment(bill.care_date, 'YYYY-MM-DD').toDate(),
          subtype: bill.care_acts[0].display_label,
          socialSecurityRefund: bill.care_acts[0].ss_base / 100,
          amount: bill.care_acts[0].reimbursed_to_user / 100,
          originalAmount: bill.care_acts[0].spent_amount / 100,
          isThirdPartyPayer: bill.care_acts[0].reimbursed_to_user === null,
          currency: '€',
          isRefund: true,
          fileAttributes: {
            metadata: {
              contentAuthor: 'alan.com',
              issueDate: utils.formatDate(new Date()),
              datetime: moment(bill.care_date, 'YYYY-MM-DD').toDate(),
              datetimeLabel: `issueDate`,
              isSubscription: false,
              carbonCopy: true,
              qualification: Qualification.getByLabel('health_invoice')
            }
          }
        }))
    )
  }

  const tpCardIdentifier = tp_card_identifier.replace(/\s/g, '')

  return { bills, tpCardIdentifier }
}

async function authenticate(email, password) {
  await this.deactivateAutoSuccessfulLogin()
  await request(`${baseUrl}/login`)
  try {
    const resp = await request.post(`${apiUrl}/auth/login`, {
      body: { email, password, refresh_token_type: 'web' }
    })
    resp.userId = jwt(resp.token).id
    await this.notifySuccessfulLogin()
    return resp
  } catch (err) {
    log('error', err.message)
    if (err.statusCode === 401) {
      throw new Error(errors.LOGIN_FAILED)
    } else {
      throw new Error(errors.VENDOR_DOWN)
    }
  }
}

function computeGroupAmounts(bills) {
  // find groupAmounts by date
  const groupedBills = groupBy(bills, 'date')
  bills = bills.map(bill => {
    if (bill.isThirdPartyPayer) return bill
    const groupAmount = groupedBills[bill.date]
      .filter(bill => !bill.isThirdPartyPayer)
      .reduce((memo, bill) => memo + bill.amount, 0)
    if (groupAmount > 0 && groupAmount !== bill.amount)
      bill.groupAmount = parseFloat(groupAmount.toFixed(2))
    return bill
  })
}

function linkFiles(bills, user) {
  let currentMonthIsReplaced = false
  let previousMonthIsReplaced = false
  bills = bills.map(bill => {
    bill.fileurl = `https://api.alan.eu/api/users/${
      user.userId
    }/decomptes?year=${moment(bill.date).format('YYYY')}&month=${moment(
      bill.date
    ).format('M')}`
    bill.filename = `${moment(bill.date).format('YYYY_MM')}_alan.pdf`
    const currentMonth = Number(moment().format('M'))
    const previousMonth = Number(
      moment()
        .startOf('month')
        .subtract(1, 'days')
        .format('M')
    )
    bill.shouldReplaceFile = (file, doc) => {
      const docMonth = Number(moment(doc.date).format('M'))
      const isCurrentMonth = docMonth === currentMonth
      const isPreviousMonth = docMonth === previousMonth

      // replace current month file only one time
      if (isCurrentMonth && !currentMonthIsReplaced) {
        currentMonthIsReplaced = true
        return true
      }
      if (isPreviousMonth && !previousMonthIsReplaced) {
        previousMonthIsReplaced = true
        return true
      }
      return false
    }
    bill.requestOptions = {
      auth: {
        bearer: user.token
      }
    }
    return bill
  })
}
