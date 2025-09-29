/**
 * 调度策略功能测试脚本
 * 用于测试分组的LRU和轮询调度策略
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
  reset: '\x1b[0m'
}

function log(message, type = 'info') {
  const color =
    {
      success: colors.green,
      error: colors.red,
      warning: colors.yellow,
      info: colors.blue
    }[type] || colors.reset

  console.log(`${color}${message}${colors.reset}`)
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function testSchedulingStrategies() {
  let testGroup = null
  let testAccounts = []
  let testApiKey = null

  try {
    await redis.connect()
    log('✅ Redis连接成功', 'success')

    // 创建测试分组（默认LRU策略）
    log('\n📝 创建测试分组（LRU策略）...', 'info')
    testGroup = await accountGroupService.createGroup({
      name: 'TEST_Strategy_Group',
      platform: 'claude',
      description: '测试调度策略',
      schedulingStrategy: 'lru'
    })
    log(`✅ 创建分组成功: ${testGroup.name}`, 'success')

    // 创建测试账户
    log('\n📝 创建测试账户...', 'info')
    for (let i = 1; i <= 3; i++) {
      const account = await claudeAccountService.createAccount({
        name: `TEST_Account_${i}`,
        email: `test${i}@example.com`,
        refreshToken: `test_token_${i}`,
        accountType: 'group',
        priority: i * 10
      })
      testAccounts.push(account)
      await accountGroupService.addAccountToGroup(account.id, testGroup.id, 'claude')
      log(`   添加账户${i}: ${account.name}`, 'info')
    }

    // 创建API Key
    testApiKey = await apiKeyService.generateApiKey({
      name: 'TEST_Strategy_Key',
      claudeAccountId: `group:${testGroup.id}`,
      permissions: 'claude'
    })
    log(`✅ 创建API Key成功`, 'success')

    // 测试LRU策略
    log('\n🔍 测试LRU策略...', 'info')
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
      lruSelections.push(account.name)
      log(`   第${i + 1}次选择: ${account.name}`, 'info')
      await sleep(100)
    }

    // 切换到轮询策略
    log('\n🔄 切换到轮询策略...', 'info')
    await accountGroupService.updateGroup(testGroup.id, {
      schedulingStrategy: 'round-robin'
    })

    // 验证策略更新
    const updatedGroup = await accountGroupService.getGroup(testGroup.id)
    if (updatedGroup.schedulingStrategy === 'round-robin') {
      log('✅ 策略切换成功', 'success')
    } else {
      throw new Error('策略切换失败')
    }

    // 测试轮询策略
    log('\n🔍 测试轮询策略...', 'info')
    const rrSelections = []
    for (let i = 0; i < 9; i++) {
      const result = await unifiedClaudeScheduler.selectAccountForApiKey({
        id: testApiKey.id,
        claudeAccountId: testApiKey.claudeAccountId,
        name: testApiKey.name
      })
      const account = testAccounts.find(a => a.id === result.accountId)
      rrSelections.push(account.name)
      log(`   第${i + 1}次选择: ${account.name}`, 'info')
      await sleep(100)
    }

    // 分析结果
    log('\n📊 测试结果分析:', 'info')
    log('   LRU策略选择模式: ' + JSON.stringify(lruSelections), 'info')
    log('   轮询策略选择模式: ' + JSON.stringify(rrSelections), 'info')

    // 验证轮询是否按顺序
    const sortedAccounts = testAccounts.sort((a, b) => a.priority - b.priority).map(a => a.name)
    let isRoundRobin = true
    for (let i = 0; i < rrSelections.length; i++) {
      const expectedIndex = i % sortedAccounts.length
      if (rrSelections[i] !== sortedAccounts[expectedIndex]) {
        isRoundRobin = false
        break
      }
    }

    if (isRoundRobin) {
      log('\n🎉 测试通过！轮询策略按预期工作', 'success')
    } else {
      log('\n⚠️ 轮询顺序可能有偏差', 'warning')
    }

    // 清理测试数据
    log('\n🧹 清理测试数据...', 'info')

    // 删除API Key
    await apiKeyService.deleteApiKey(testApiKey.id)
    log('   删除API Key', 'info')

    // 删除账户
    for (const account of testAccounts) {
      await claudeAccountService.deleteAccount(account.id)
      log(`   删除账户: ${account.name}`, 'info')
    }

    // 清空分组成员后删除分组
    const members = await accountGroupService.getGroupMembers(testGroup.id)
    for (const memberId of members) {
      await accountGroupService.removeAccountFromGroup(memberId, testGroup.id)
    }
    await accountGroupService.deleteGroup(testGroup.id)
    log('   删除分组', 'info')

    log('\n✅ 测试完成！', 'success')

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
testSchedulingStrategies()