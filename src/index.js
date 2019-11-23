process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://c3b054eb15454092a0b64d6ec6527d23@sentry.cozycloud.cc/119'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  saveFiles,
  saveBills,
  cozyClient,
  utils
} = require('cozy-konnector-libs')
const jwt = require('jwt-decode')
const { Document } = require('cozy-doctypes')
const moment = require('moment')
const groupBy = require('lodash/groupBy')
const keyBy = require('lodash/keyBy')
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})

const baseUrl = 'https://alan.eu'
const apiUrl = 'https://api.alan.eu'
const set = require('lodash/set')
const get = require('lodash/get')

module.exports = new BaseKonnector(start)

async function start(fields) {
  await removeOldBills()
  await cleanBillsWithTrashedFiles()

  log('info', 'Authenticating ...')
  const user = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  let { bills, policyId } = await fetchData(user)

  computeGroupAmounts(bills)
  linkFiles(bills, user)

  await saveBills(bills, fields.folderPath, {
    identifiers: ['alan'],
    keys: ['vendorRef', 'beneficiary', 'date'],
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login,
    linkBankOperations: false
  })

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
    fields,
    {
      contentType: 'application/pdf',
      sourceAccount: this.accountId,
      sourceAccountIdentifier: fields.login
    }
  )
}

async function fetchData(user) {
  const { beneficiaries, insurance_profile } = await request(
    `${apiUrl}/api/users/${user.userId}?expand=beneficiaries.insurance_profile.legacy_coverages,beneficiaries.insurance_profile.settlements,beneficiaries.insurance_profile.teletransmission_status_to_display,beneficiaries.insurance_profile.user.current_settlement_iban,invoices,insurance_profile,address,current_billing_iban,current_settlement_iban,current_exemption.company.current_contract.current_prevoyance_contract.prevoyance_plan,company.current_contract.current_prevoyance_contract.prevoyance_plan,company.current_contract.current_plan,company.current_contract.discounts,insurance_profile.current_policy.contract.current_plan,insurance_profile.current_policy.contract.contractee,legacy_health_contract,current_contract.madelin_attestations,current_contract.amendments,current_contract.current_plan,accountant,insurance_documents,insurance_documents.quotes,authorized_billing_ibans`,
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
          vendorRef: bill.created_at,
          beneficiary: name,
          type: 'health_costs',
          date: moment(bill.estimated_payment_date, 'YYYY-MM-DD').toDate(),
          originalDate: moment(bill.care_date, 'YYYY-MM-DD').toDate(),
          subtype: bill.displayed_label,
          description: bill.care_type_desc,
          socialSecurityRefund: bill.ss_amount / 100,
          amount: bill.covered_amount / 100,
          originalAmount: bill.total_amount / 100,
          isThirdPartyPayer: bill.origin === 'tiers_payant',
          currency: '€',
          isRefund: true
        }))
    )
  }

  const policyId = insurance_profile.current_policy.id

  return { bills, policyId }
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

function computeGroupAmounts(bills) {
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
}

function linkFiles(bills, user) {
  let currentMonthIsReplaced = false
  let previousMonthIsReplaced = false
  bills = bills.map(bill => {
    set(bill, 'fileAttributes.metadata.checkUpdate', undefined)
    bill.fileAttributes.metadata
    bill.fileurl = `https://api.alan.eu/api/users/${
      user.userId
    }/settlements?year=${moment(bill.date).format('YYYY')}&month=${moment(
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

/**
 * This function remove old alan bills with old vendorRef attribute which is not a stable id (it
 * changes every day.
 * we now use the creation date, which seems to be stable and sharp enough to be unique
 * Removed bills which are associated to a bank operation will be ignored by cozy-banks and
 * eventually removed by the association service
 */
async function removeOldBills() {
  try {
    class BillsDocument extends Document {}
    BillsDocument.doctype = 'io.cozy.bills'
    BillsDocument.registerClient(cozyClient)
    const billsToRemove = (await BillsDocument.queryAll({
      vendor: 'alan'
    })).filter(doc => typeof doc.vendorRef === 'number')

    if (billsToRemove.length) {
      log('warn', `Found ${billsToRemove.length} old alan bills to remove`)
      await BillsDocument.deleteAll(billsToRemove)
      log('warn', `Old alan bills removed`)
    } else {
      log('info', 'No old alan bills to remove')
    }
  } catch (err) {
    log('warn', 'error while trying to remove old alan bills : ' + err.message)
  }
}

async function cleanBillsWithTrashedFiles() {
  const trashedFiles = await utils.queryAll('io.cozy.files', {
    dir_id: 'io.cozy.files.trash-dir'
  })
  const trashedFileIndex = keyBy(trashedFiles, '_id')
  const alanBills = await utils.queryAll('io.cozy.bills', {
    vendor: 'alan'
  })

  const alanBillsToRemove = alanBills.filter(
    bill =>
      trashedFileIndex[
        get(bill, 'invoice', '')
          .split(':')
          .pop()
      ]
  )
  if (alanBillsToRemove.length) {
    log(
      'warn',
      `Will remove ${alanBillsToRemove.length} bills associated to files in trash`
    )

    await utils.batchDelete('io.cozy.bills', alanBillsToRemove)
    log('info', 'done removing')
  }
}
