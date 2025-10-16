const droidAccountService = require('./droidAccountService')
const accountGroupService = require('./accountGroupService')
const redis = require('../models/redis')
const logger = require('../utils/logger')

class DroidScheduler {
  constructor() {
    this.STICKY_PREFIX = 'droid'
  }

  _normalizeEndpointType(endpointType) {
    if (!endpointType) {
      return 'anthropic'
    }
    const normalized = String(endpointType).toLowerCase()
    if (normalized === 'openai' || normalized === 'common') {
      return 'openai'
    }
    return 'anthropic'
  }

  _isTruthy(value) {
    if (value === undefined || value === null) {
      return false
    }
    if (typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true'
    }
    return Boolean(value)
  }

  _isAccountActive(account) {
    if (!account) {
      return false
    }
    const isActive = this._isTruthy(account.isActive)
    if (!isActive) {
      return false
    }

    const status = (account.status || 'active').toLowerCase()
    const unhealthyStatuses = new Set(['error', 'unauthorized', 'blocked'])
    return !unhealthyStatuses.has(status)
  }

  _isAccountSchedulable(account) {
    return this._isTruthy(account?.schedulable ?? true)
  }

  _matchesEndpoint(account, endpointType) {
    const normalizedEndpoint = this._normalizeEndpointType(endpointType)
    const accountEndpoint = this._normalizeEndpointType(account?.endpointType)
    if (normalizedEndpoint === accountEndpoint) {
      return true
    }

    const sharedEndpoints = new Set(['anthropic', 'openai'])
    return sharedEndpoints.has(normalizedEndpoint) && sharedEndpoints.has(accountEndpoint)
  }

  _sortCandidates(candidates) {
    return [...candidates].sort((a, b) => {
      const priorityA = parseInt(a.priority, 10) || 50
      const priorityB = parseInt(b.priority, 10) || 50

      if (priorityA !== priorityB) {
        return priorityA - priorityB
      }

      const lastUsedA = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0
      const lastUsedB = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0

      if (lastUsedA !== lastUsedB) {
        return lastUsedA - lastUsedB
      }

      const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return createdA - createdB
    })
  }

  _composeStickySessionKey(endpointType, sessionHash, apiKeyId) {
    if (!sessionHash) {
      return null
    }
    const normalizedEndpoint = this._normalizeEndpointType(endpointType)
    const apiKeyPart = apiKeyId || 'default'
    return `${this.STICKY_PREFIX}:${normalizedEndpoint}:${apiKeyPart}:${sessionHash}`
  }

  async _loadGroupAccounts(groupId) {
    const memberIds = await accountGroupService.getGroupMembers(groupId)
    if (!memberIds || memberIds.length === 0) {
      return []
    }

    const accounts = await Promise.all(
      memberIds.map(async (memberId) => {
        try {
          return await droidAccountService.getAccount(memberId)
        } catch (error) {
          logger.warn(`⚠️ 获取 Droid 分组成员账号失败: ${memberId}`, error)
          return null
        }
      })
    )

    return accounts.filter(
      (account) => account && this._isAccountActive(account) && this._isAccountSchedulable(account)
    )
  }

  async _ensureLastUsedUpdated(accountId) {
    try {
      await droidAccountService.touchLastUsedAt(accountId)
    } catch (error) {
      logger.warn(`⚠️ 更新 Droid 账号最后使用时间失败: ${accountId}`, error)
    }
  }

  async _cleanupStickyMapping(stickyKey) {
    if (!stickyKey) {
      return
    }
    try {
      await redis.deleteSessionAccountMapping(stickyKey)
    } catch (error) {
      logger.warn(`⚠️ 清理 Droid 粘性会话映射失败: ${stickyKey}`, error)
    }
  }

  async selectAccount(apiKeyData, endpointType, sessionHash) {
    const normalizedEndpoint = this._normalizeEndpointType(endpointType)
    const stickyKey = this._composeStickySessionKey(normalizedEndpoint, sessionHash, apiKeyData?.id)

    let candidates = []
    let isDedicatedBinding = false
    let groupId = null
    let group = null

    if (apiKeyData?.droidAccountId) {
      const binding = apiKeyData.droidAccountId
      if (binding.startsWith('group:')) {
        groupId = binding.substring('group:'.length)
        group = await accountGroupService.getGroup(groupId)
        logger.info(
          `🤖 API Key ${apiKeyData.name || apiKeyData.id} 绑定 Droid 分组 ${groupId}，按分组调度（策略：${group?.schedulingStrategy || 'lru'}）`
        )
        candidates = await this._loadGroupAccounts(groupId, normalizedEndpoint)
      } else {
        const account = await droidAccountService.getAccount(binding)
        if (account) {
          candidates = [account]
          isDedicatedBinding = true
        }
      }
    }

    if (!candidates || candidates.length === 0) {
      candidates = await droidAccountService.getSchedulableAccounts(normalizedEndpoint)
    }

    const filtered = candidates.filter(
      (account) =>
        account &&
        this._isAccountActive(account) &&
        this._isAccountSchedulable(account) &&
        this._matchesEndpoint(account, normalizedEndpoint)
    )

    if (filtered.length === 0) {
      throw new Error(
        `No available accounts for endpoint ${normalizedEndpoint}${apiKeyData?.droidAccountId ? ' (respecting binding)' : ''}`
      )
    }

    // 轮询策略不使用会话粘性
    if (stickyKey && !isDedicatedBinding && group?.schedulingStrategy !== 'round-robin') {
      const mappedAccountId = await redis.getSessionAccountMapping(stickyKey)
      if (mappedAccountId) {
        const mappedAccount = filtered.find((account) => account.id === mappedAccountId)
        if (mappedAccount) {
          await redis.extendSessionAccountMappingTTL(stickyKey)
          logger.info(
            `🤖 命中 Droid 粘性会话: ${sessionHash} -> ${mappedAccount.name || mappedAccount.id}`
          )
          await this._ensureLastUsedUpdated(mappedAccount.id)
          return mappedAccount
        }

        await this._cleanupStickyMapping(stickyKey)
      }
    }

    let selected

    // 如果是分组调度且使用 round-robin 策略
    if (group && group.schedulingStrategy === 'round-robin') {
      selected = await this._selectByRoundRobin(filtered, groupId)
    } else {
      // 默认 LRU 策略：按优先级和最后使用时间排序
      const sorted = this._sortCandidates(filtered)
      selected = sorted[0]

      // LRU 策略支持会话粘性
      if (stickyKey && !isDedicatedBinding) {
        await redis.setSessionAccountMapping(stickyKey, selected.id)
      }
    }

    if (!selected) {
      throw new Error(`No schedulable account available after sorting (${normalizedEndpoint})`)
    }

    await this._ensureLastUsedUpdated(selected.id)

    logger.info(
      `🤖 选择 Droid 账号 ${selected.name || selected.id}（endpoint: ${normalizedEndpoint}, priority: ${selected.priority || 50}${group ? `, 策略: ${group.schedulingStrategy || 'lru'}` : ''}）`
    )

    return selected
  }

  async _selectByRoundRobin(accounts, groupId) {
    // 先按优先级分组
    const accountsByPriority = {}
    accounts.forEach((account) => {
      const priority = parseInt(account.priority, 10) || 50
      if (!accountsByPriority[priority]) {
        accountsByPriority[priority] = []
      }
      accountsByPriority[priority].push(account)
    })

    // 获取最高优先级（数字越小优先级越高）
    const priorities = Object.keys(accountsByPriority)
      .map((p) => parseInt(p, 10))
      .sort((a, b) => a - b)
    const highestPriority = priorities[0]
    const highestPriorityAccounts = accountsByPriority[highestPriority]

    // 按 name 排序，确保同优先级账户顺序稳定
    highestPriorityAccounts.sort((a, b) => a.name.localeCompare(b.name))

    // 为每个优先级维护独立的索引
    const indexKey = `roundRobinIndex_${highestPriority}`
    const group = await accountGroupService.getGroup(groupId)
    const currentIndex = parseInt(group[indexKey], 10) || 0
    const nextIndex = currentIndex % highestPriorityAccounts.length
    const selectedAccount = highestPriorityAccounts[nextIndex]

    // 更新该优先级组的索引
    const updateData = {}
    updateData[indexKey] = ((nextIndex + 1) % highestPriorityAccounts.length).toString()
    const client = redis.getClientSafe()
    await client.hmset(`account_group:${groupId}`, updateData)

    logger.info(
      `🔄 Droid Round-robin 选择（优先级 ${highestPriority}）: ${selectedAccount.name} (索引: ${nextIndex}/${highestPriorityAccounts.length})`
    )

    return selectedAccount
  }
}

module.exports = new DroidScheduler()
