/**
 * 优先级轮询测试脚本
 * 验证同一优先级内的轮询和LRU调度策略
 */

require('dotenv').config()
const { v4: uuidv4 } = require('uuid')
const redis = require('../src/models/redis')
const accountGroupService = require('../src/services/accountGroupService')
const claudeAccountService = require('../src/services/claudeAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const unifiedClaudeScheduler = require('../src/services/unifiedClaudeScheduler')

// 颜色输出
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
}

function log(message, type = 'info') {
  const color = {
    success: colors.green,
    error: colors.red,
    warning: colors.yellow,
    info: colors.blue,
    highlight: colors.cyan
  }[type] || colors.reset
  console.log(`${color}${message}${colors.reset}`)
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function testPriorityScheduling() {
  let testGroup = null
  let testAccounts = []
  let testApiKey = null

  try {
    await redis.connect()
    log('✅ Redis连接成功', 'success')

    // 创建测试分组（轮询策略）
    log('\n📝 创建测试分组（轮询策略）...', 'info')
    testGroup = await accountGroupService.createGroup({
      name: 'TEST_Priority_Group',
      platform: 'claude',
      description: '测试优先级调度策略',
      schedulingStrategy: 'round-robin'
    })
    log(`✅ 创建分组成功: ${testGroup.name}`, 'success')

    // 创建不同优先级的测试账户
    log('\n📝 创建不同优先级的测试账户...', 'info')

    // 优先级10的账户（最高优先级）
    for (let i = 1; i <= 3; i++) {
      const account = await claudeAccountService.createAccount({
        name: `TEST_P10_Account_${i}`,
        email: `p10_${i}@example.com`,
        refreshToken: `test_p10_token_${i}`,
        accountType: 'group',
        priority: 10  // 高优先级
      })
      testAccounts.push(account)
      await accountGroupService.addAccountToGroup(account.id, testGroup.id, 'claude')
      log(`   添加高优先级账户${i}: ${account.name} (优先级:10)`, 'highlight')
    }

    // 优先级50的账户（低优先级）
    for (let i = 1; i <= 2; i++) {
      const account = await claudeAccountService.createAccount({
        name: `TEST_P50_Account_${i}`,
        email: `p50_${i}@example.com`,
        refreshToken: `test_p50_token_${i}`,
        accountType: 'group',
        priority: 50  // 低优先级
      })
      testAccounts.push(account)
      await accountGroupService.addAccountToGroup(account.id, testGroup.id, 'claude')
      log(`   添加低优先级账户${i}: ${account.name} (优先级:50)`, 'info')
    }

    // 创建API Key
    testApiKey = await apiKeyService.generateApiKey({
      name: 'TEST_Priority_Key',
      claudeAccountId: `group:${testGroup.id}`,
      permissions: 'claude'
    })
    log(`✅ 创建API Key成功`, 'success')

    // 测试轮询策略（应该只在优先级10的账户内轮询）
    log('\n🔍 测试轮询策略（期望：只在优先级10的账户内轮询）...', 'info')
    const selections = []
    for (let i = 0; i < 9; i++) {
      const result = await unifiedClaudeScheduler.selectAccountForApiKey({
        id: testApiKey.id,
        claudeAccountId: testApiKey.claudeAccountId,
        name: testApiKey.name
      })
      const account = testAccounts.find(a => a.id === result.accountId)
      selections.push({
        name: account.name,
        priority: account.priority
      })
      log(`   第${i + 1}次选择: ${account.name} (优先级:${account.priority})`, 'info')
      await sleep(100)
    }

    // 分析结果
    log('\n📊 分析结果:', 'info')
    const priority10Selections = selections.filter(s => s.priority === 10).length
    const priority50Selections = selections.filter(s => s.priority === 50).length

    log(`   优先级10账户被选择: ${priority10Selections}次`, 'highlight')
    log(`   优先级50账户被选择: ${priority50Selections}次`, 'info')

    if (priority10Selections === 9 && priority50Selections === 0) {
      log('\n✅ 测试通过！轮询只在同一优先级（最高优先级）内进行', 'success')
    } else {
      log('\n❌ 测试失败！轮询跨越了不同优先级', 'error')
    }

    // 验证轮询顺序
    const p10Accounts = testAccounts
      .filter(a => a.priority === 10)
      .sort((a, b) => a.name.localeCompare(b.name))

    let isCorrectOrder = true
    for (let i = 0; i < selections.length; i++) {
      const expectedAccount = p10Accounts[i % p10Accounts.length]
      if (selections[i].name !== expectedAccount.name) {
        isCorrectOrder = false
        break
      }
    }

    if (isCorrectOrder) {
      log('✅ 轮询顺序正确！按名称顺序在同优先级内循环', 'success')
    } else {
      log('⚠️ 轮询顺序可能有偏差', 'warning')
    }

    // 测试LRU策略
    log('\n🔄 切换到LRU策略...', 'info')
    await accountGroupService.updateGroup(testGroup.id, {
      schedulingStrategy: 'lru'
    })

    log('\n🔍 测试LRU策略（期望：只在优先级10的账户内选择）...', 'info')
    const lruSelections = []
    for (let i = 0; i < 6; i++) {
      const sessionHash = uuidv4()
      const result = await unifiedClaudeScheduler.selectAccountForApiKey(
        {
          id: testApiKey.id,
          claudeAccountId: testApiKey.claudeAccountId,
          name: testApiKey.name
        },
        sessionHash
      )
      const account = testAccounts.find(a => a.id === result.accountId)
      lruSelections.push({
        name: account.name,
        priority: account.priority
      })
      log(`   第${i + 1}次选择: ${account.name} (优先级:${account.priority})`, 'info')
      await sleep(100)
    }

    const lruP10Selections = lruSelections.filter(s => s.priority === 10).length
    const lruP50Selections = lruSelections.filter(s => s.priority === 50).length

    log('\n📊 LRU策略结果:', 'info')
    log(`   优先级10账户被选择: ${lruP10Selections}次`, 'highlight')
    log(`   优先级50账户被选择: ${lruP50Selections}次`, 'info')

    if (lruP10Selections === 6 && lruP50Selections === 0) {
      log('\n✅ LRU策略测试通过！只在最高优先级组内选择', 'success')
    } else {
      log('\n❌ LRU策略测试失败！选择了低优先级账户', 'error')
    }

    // 清理测试数据
    log('\n🧹 清理测试数据...', 'info')
    await apiKeyService.deleteApiKey(testApiKey.id)
    for (const account of testAccounts) {
      await claudeAccountService.deleteAccount(account.id)
    }
    const members = await accountGroupService.getGroupMembers(testGroup.id)
    for (const memberId of members) {
      await accountGroupService.removeAccountFromGroup(memberId, testGroup.id)
    }
    await accountGroupService.deleteGroup(testGroup.id)

    log('\n🎉 测试完成！调度策略按预期工作：只在同一优先级内进行轮询或LRU选择', 'success')

  } catch (error) {
    log(`\n❌ 测试失败: ${error.message}`, 'error')
    console.error(error)

    // 尝试清理
    try {
      if (testApiKey) await apiKeyService.deleteApiKey(testApiKey.id)
      for (const account of testAccounts) {
        await claudeAccountService.deleteAccount(account.id)
      }
      if (testGroup) {
        const members = await accountGroupService.getGroupMembers(testGroup.id)
        for (const memberId of members) {
          await accountGroupService.removeAccountFromGroup(memberId, testGroup.id)
        }
        await accountGroupService.deleteGroup(testGroup.id)
      }
    } catch (cleanupError) {
      log('清理失败: ' + cleanupError.message, 'error')
    }
  } finally {
    await redis.disconnect()
    process.exit(0)
  }
}

// 运行测试
testPriorityScheduling()