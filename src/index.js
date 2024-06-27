import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
import { format, subMonths } from 'date-fns'
import groupBy from 'lodash/groupBy'
Minilog.enable('alanCCC')

// Keeping this interception around for later investigations, mandatory for autoLogin
// Here we need to intercept the prehashed_password in the login's request
// to be able to make the autoLogin work on next connection.
// let preHashedPassword
// const constantMock = window.fetch
// window.fetch = function () {
//   if (arguments[0].includes !== undefined) {
//     if (
//       arguments[0].includes(
//         'idp.alan.com/realms/alan/protocol/openid-connect/token'
//       )
//     ) {
//       if (arguments[1]) {
//         // The sent password in this request is preHashed by alan when sending loginForm
//         const paramsObject = Object.fromEntries(
//           new URLSearchParams(arguments[1].body).entries()
//         )
//         preHashedPassword = paramsObject.password
//       }
//       return constantMock.apply(this, arguments)
//     } else {
//       return constantMock.apply(this, arguments)
//     }
//   }
//   return constantMock.apply(this, arguments)
// }

const BASE_URL = 'https://alan.com/'
const LOGIN_URL = 'https://alan.com/login'
const HOMEPAGE_URL = 'https://alan.com/app/dashboard'
const LOGOUT_URL = `${BASE_URL}/logout`

class TemplateContentScript extends ContentScript {
  // ////////
  // PILOT //
  // ////////
  async onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      const { login, password } = payload || {}
      if (login && password) {
        this.store.userCredentials = { login, password }
      } else {
        this.log('warn', 'Did not manage to intercept credentials')
      }
    }
  }

  async onWorkerReady() {
    function addSubmitListener() {
      const submitButton = document.querySelector(
        'button[data-testid="submitButton"]'
      )
      submitButton.addEventListener('click', () => {
        const login = document.querySelector(`input[name="email"]`)?.value
        const password = document.querySelector('input[name="password"]')?.value
        this.bridge.emit('workerEvent', {
          event: 'loginSubmit',
          payload: { login, password }
        })
      })
    }
    await this.waitForElementNoReload('input[name="email"]')
    this.log('info', 'Form detected, adding listener')
    addSubmitListener.bind(this)()
  }

  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm starts')
    // Here we navigate directly to the dashboard page because if we're already connected, we stay on the dashboard page
    // but if not, there is a redirection to the loginForm
    await this.goto(HOMEPAGE_URL)
    await Promise.race([
      this.waitForElementInWorker('input[name="email"]'),
      this.waitForElementInWorker('.ListItem__Clickable')
    ])
  }

  async ensureNotAuthenticated() {
    this.log('info', 'ensureNotAuthenticated starts')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'not auth, returning true')
      return true
    }
    this.log('info', 'Auth detected, logging out')
    await this.goto(LOGOUT_URL)
    await this.waitForElementInWorker('a[href="/login"]')
    return true
  }

  async ensureAuthenticated() {
    this.log('info', 'ensureAuthenticated starts')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    await this.navigateToLoginForm()
    // No more autoFill or autoLogin possible, website is checking isTrusted
    const credentials = await this.getCredentials()
    if (credentials) {
      if (await this.isElementInWorker('.ListItem__Clickable')) {
        this.log('info', 'Logged from previous run, continue')
        return true
      }
    }
    const auth = await this.userAuth()
    if (auth) {
      return true
    }
    return false
  }

  async waitForUserAuthentication() {
    this.log('debug', 'waitForUserAuthentication starts')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    const userInfos = await this.runInWorker('getUserData')
    this.store = { ...this.store, ...userInfos }
    const credentials = await this.getCredentials()
    const credentialsLogin = credentials?.login
    const storeLogin = this.store?.userCredentials?.login

    // prefer credentials over user email since it may not be know by the user
    let sourceAccountIdentifier = credentialsLogin || storeLogin
    if (!sourceAccountIdentifier) {
      sourceAccountIdentifier = this.store.userIdentity?.email
    }

    if (!sourceAccountIdentifier) {
      throw new Error(
        'Could not get a sourceAccountIdentifier, no credentials found or saved, no email in identity'
      )
    }
    return {
      sourceAccountIdentifier: sourceAccountIdentifier
    }
  }

  async fetch(context) {
    this.log('fetch starts')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    let documents = await this.runInWorker(
      'getDocuments',
      this.store.userDatas,
      this.store.token
    )
    await this.saveFiles(documents.tpCard, {
      context,
      contentType: 'application/pdf',
      fileIdAttributes: ['filename'],
      qualificationLabel: 'health_insurance_card'
    })
    // Classify bills by date
    documents.bills.sort(function (a, b) {
      return new Date(b.date).getTime() - new Date(a.date).getTime()
    })
    const numberOfBills = documents.bills.length
    let savedBills = 0
    this.log('debug', `Found ${numberOfBills} bills`)
    // Saving bills by block of ten
    while (documents.bills.length !== 0) {
      const tenBlock = documents.bills.splice(0, 10)
      savedBills = savedBills + tenBlock.length
      await this.saveBills(tenBlock, {
        context,
        keys: ['vendorRef', 'beneficiary', 'date'],
        fileIdAttributes: ['filename'],
        contentType: 'application/pdf',
        qualificationLabel: 'health_invoice'
      })
      this.log('debug', `bills saved : ${savedBills}/${numberOfBills}`)
    }
  }

  async userAuth() {
    this.log('info', '📍️ userAuth starts')
    if (!(await this.isElementInWorker('input[name="email"]'))) {
      this.log('debug', 'Not login page')
      await this.goto(LOGIN_URL)
      await this.waitForElementInWorker('input[name="email"]')
    }
    await this.waitForUserAuthentication()
    const isAskingForDownloadAgain = await this.runInWorker(
      'checkAskForAppDownload'
    )
    if (isAskingForDownloadAgain) {
      await this.clickAndWait(
        // on the askingForDownload page, there's only one "button" element, the other is an "a", so no need precise specifications after checking
        'button',
        'div[class="ListItem ListItem__Clickable ListCareEventItem"]'
      )
    }
    return true
  }

  // ////////
  // WORKER//
  // ////////

  async checkAuthenticated() {
    if (
      (document.location.href.includes(`${HOMEPAGE_URL}`) &&
        document.querySelector('a[href="#"]')) ||
      document.querySelector(
        'div[class="ListItem ListItem__Clickable ListCareEventItem"]'
      )
    ) {
      this.log('info', 'Auth Check succeeded')
      return true
    }
    this.log('debug', 'Not respecting condition, returning false')
    return false
  }

  checkAskForAppDownload() {
    this.log('info', '📍️ checkAskForAppDownload starts')
    const cantDownloadAppButton = document.querySelector(
      'a[href="https://link.alan.com/app/dashboard"]'
    )?.nextElementSibling
    if (cantDownloadAppButton.textContent.includes('Je ne peux pas')) {
      return true
    } else {
      return false
    }
  }

  checkIfLogged() {
    if (document.location.href === HOMEPAGE_URL) {
      return true
    } else {
      return false
    }
  }

  getUserMail() {
    this.log('info', '📍️ getUserMail starts')
    const userInfosElements = document.querySelectorAll('.value-box-value')
    const userMail = userInfosElements[3].innerHTML
    if (userMail) {
      return userMail
    }
    return 'UNKNOWN_ERROR'
  }

  async getUserData() {
    this.log('info', '📍️ getUserData starts')
    let token = await this.getCookieByDomainAndName(
      'https://api.alan.com',
      'token'
    )
    const documentsUrl =
      'https://api.alan.com/api/users/${beneficiaryId}?expand=visible_insurance_documents,address,beneficiaries,beneficiaries.insurance_profile.user,beneficiaries.insurance_profile.latest_tp_card'
    const jsonDocuments = await this.fetchAlanApi(documentsUrl, token.value)
    const beneficiaries = jsonDocuments.beneficiaries
    let beneficiariesWithIds = []
    for (const beneficiary of beneficiaries) {
      const name = beneficiary.insurance_profile.user.normalized_full_name
      const beneficiaryId = beneficiary.insurance_profile_id
      const userId = beneficiary.insurance_profile.user.id
      beneficiariesWithIds.push({
        name,
        beneficiaryId,
        userId
      })
    }
    const eventsUrl = `https://api.alan.com/api/insurance_profiles/${beneficiariesWithIds[0].beneficiaryId}/care_events_public`
    const jsonEvents = await this.fetchAlanApi(eventsUrl, token.value)
    const {
      email,
      birth_date: birthDate,
      first_name: firstName,
      last_name: lastName,
      address
    } = jsonDocuments
    const socialSecurityNumber =
      jsonDocuments.beneficiaries[0].insurance_profile.ssn
    const { postal_code: postCode, city, street, country } = address
    const userIdentity = {
      email,
      birthDate,
      socialSecurityNumber,
      name: {
        firstName,
        lastName,
        fullname: `${firstName} ${lastName}`
      },
      address: [
        {
          formattedAddress: `${street} ${postCode} ${city} ${country}`,
          postCode,
          city,
          street,
          country
        }
      ]
    }
    const userDatas = {
      jsonDocuments,
      jsonEvents,
      beneficiariesWithIds
    }
    const userInfos = {
      userDatas,
      userIdentity,
      token
    }
    return userInfos
  }

  async getDocuments(userDatas, token) {
    this.log('info', '📍️ getDocuments starts')
    let { bills, tpCardIdentifier } = await this.computeDocuments(
      userDatas.jsonDocuments,
      userDatas.jsonEvents
    )
    bills = this.computeGroupAmounts(bills)
    bills = this.linkFiles(bills, userDatas.beneficiariesWithIds, token.value)
    const tpCard = await this.getTpCard(tpCardIdentifier, token.value)
    return {
      tpCard,
      bills
    }
  }

  async computeDocuments(jsonDocuments, jsonEvents) {
    this.log('info', '📍️ computeDocuments starts')
    let bills = []
    for (const beneficiary of jsonDocuments.beneficiaries) {
      const name = beneficiary.insurance_profile.user.normalized_full_name
      bills.push.apply(
        bills,
        jsonEvents
          .filter(bill => bill.status === 'refunded')
          .map(function (bill) {
            const originalDate = format(new Date(bill.care_date), 'yyyy-MM-dd')
            return {
              vendor: 'alan',
              vendorRef: bill.id,
              beneficiary: name,
              type: 'health_costs',
              date: new Date(bill.estimated_payment_date),
              originalDate,
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
                  issueDate: new Date(),
                  datetime: originalDate,
                  datetimeLabel: `issueDate`,
                  isSubscription: false,
                  carbonCopy: true
                }
              }
            }
          })
      )
    }
    const tpCardIdentifier = jsonDocuments.tp_card_identifier.replace(/\s/g, '')

    return { bills, tpCardIdentifier }
  }

  computeGroupAmounts(bills) {
    this.log('debug', 'Starting computeGroupAmount')
    // find groupAmounts by date
    const groupedBills = groupBy(bills, 'date')
    return bills.map(bill => {
      if (bill.isThirdPartyPayer) return bill
      const groupAmount = groupedBills[bill.date]
        .filter(bill => !bill.isThirdPartyPayer)
        .reduce((memo, bill) => memo + bill.amount, 0)
      if (groupAmount > 0 && groupAmount !== bill.amount)
        bill.groupAmount = parseFloat(groupAmount.toFixed(2))
      return bill
    })
  }

  linkFiles(bills, beneficiariesWithIds, token) {
    this.log('info', '📍️ linkFiles starts')
    let currentMonthIsReplaced = false
    let previousMonthIsReplaced = false
    return bills.map(bill => {
      bill.fileurl = `https://api.alan.com/api/users/${
        beneficiariesWithIds[0].userId
      }/decomptes?year=${format(new Date(bill.date), 'yyyy')}&month=${format(
        new Date(bill.date),
        'MM'
      )}`
      bill.filename = `${format(new Date(bill.date), 'yyyy_MM')}_alan.pdf`
      const currentMonth = Number(format(new Date(), 'MM'))
      const previousMonth = Number(format(subMonths(currentMonth, 1), 'MM'))
      bill.shouldReplaceFile = (file, doc) => {
        const docMonth = Number(format(new Date(doc.date), 'MM'))
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
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
      return bill
    })
  }

  async getTpCard(tpCardIdentifier, token) {
    this.log('info', '📍️ getTpCard starts')
    let tpCard = []
    tpCard.push({
      fileurl: `https://api.alan.com/api/users/${tpCardIdentifier}/tp-card?t=${Date.now()}`,
      filename: 'Carte_Mutuelle.pdf',
      fileAttributes: {
        metadata: {
          contentAuthor: 'alan.com',
          datetime: new Date(),
          datetimeLabel: `issueDate`,
          isSubscription: false,
          carbonCopy: true
        }
      },
      shouldReplaceFile: () => true,
      requestOptions: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    })
    return tpCard
  }

  checkAskForLogin() {
    if (
      document.querySelector('input[name="email"]') &&
      document.querySelector('input[name="password"]')
    )
      return true
    return false
  }

  // Same here, keeping this around for later investigation for autoLogin
  // async makeLoginReq(credentials) {
  //   this.log('info', '📍️ makeLoginReq starts')
  //   let cookies = document.cookie
  //   const tokenLoginUrl = 'https://api.alan.com/auth/login_idp'
  //   const tokenUrl =
  //     'https://idp.alan.com/realms/alan/protocol/openid-connect/token'
  //   const loginResponse = await window
  //     .fetch(tokenUrl, {
  //       method: 'POST',
  //       body: `client_id=fr-web-prod&grant_type=password&username=${credentials.login}&password=${credentials.preHashedPassword}`,
  //       headers: {
  //         'Content-Type': 'application/x-www-form-urlencoded',
  //         Cookie: cookies
  //       },
  //       resolveWithFullResponse: true
  //     })
  //     .then(res => res.json())
  //   // if (!loginResponse.token_payload) {
  //   //   return false
  //   // }
  //   // await this.sendToPilot({ loginResponse })
  //   // return true
  //   if (!loginResponse.access_token) {
  //     this.log('debug', 'Login response failed, check the code')
  //     return false
  //   }
  //   cookies = document.cookie
  //   const tokenResponse = await window
  //     .fetch(tokenLoginUrl, {
  //       method: 'POST',
  //       body: `{"access_token":"${loginResponse.access_token}", "refresh_token_type":"web"}`,
  //       headers: {
  //         'Content-Type': 'application/json',
  //         Cookie: cookies
  //       },
  //       resolveWithFullResponse: true
  //     })
  //     .then(res => res.json())
  //   if (!tokenResponse.token_payload) {
  //     this.log('debug', 'Token response failed, check the code')
  //     return false
  //   }
  //   return loginResponse
  // }

  async fetchAlanApi(url, token) {
    this.log('info', 'fetchAlanApi starts')
    let urlToCheck = url
    let tokenPayload = window.localStorage.tokenPayload
    let beneficiaryId = tokenPayload
      .split(',')[1]
      .replace(/"/g, '')
      .split(':')[1]
    if (urlToCheck.includes('${beneficiaryId}')) {
      urlToCheck = urlToCheck.replace('${beneficiaryId}', beneficiaryId)
    }
    const response = await window.fetch(urlToCheck, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    const jsonResponse = await response.json()
    return jsonResponse
  }
}

const connector = new TemplateContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'checkAskForAppDownload',
      'checkIfLogged',
      'getUserMail',
      'getUserData',
      'getDocuments',
      'checkAskForLogin'
      // 'makeLoginReq'
    ]
  })
  .catch(err => {
    log('warn', err)
  })
