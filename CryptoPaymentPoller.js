class PaymentPoller {
    constructor({ shiftProcessor, intervalTimeout = 30000, resetCryptoPayment, confirmCryptoPayment }) {
        if (!shiftProcessor) throw new Error('Missing parameter "shiftProcessor". PaymentPoller need sideshift API access to run')

        // Set initial Polling control
        this.isPolling = false;
        this.pollTimer = null;

        // Store active polling queue and shift data
        this.pollingQueue = new Set();
        this.shiftMapping = new Map();
        this.failedMapping = new Map();
        this.retryTimers = new Map(); // shiftId -> timeoutId

        // Set polling interval in ms, default to 2 minutes
        this.timeout = Number(intervalTimeout);
        this.maxAge = 48 * 60 * 60 * 1000; // 48 hours
        this.maxRetries = 5; // 20
        this.cappedRetryDelay = 10000; //120000; // 2 minutes cap

        // setting sideshift API 
        this.shiftProcessor = shiftProcessor;
        // Use sideshift Verbose setting
        this.verbose = shiftProcessor.verbose;

        // Import logic function to confirm and reset payment
        this.confirmCryptoPayment = confirmCryptoPayment;
        this.resetCryptoPayment = resetCryptoPayment;
    }

    // Calculate exponential backoff with jitter
    calculateBackoffDelay(retries) {
        if (retries >= this.maxRetries) {
            return this.cappedRetryDelay;
        }

        const baseDelay = Math.pow(2, retries) * 1000;
        const cappedBaseDelay = Math.min(baseDelay, this.cappedRetryDelay);
        const jitter = Math.floor(Math.random() * 1000);
        return cappedBaseDelay + jitter;
    }

    // Clear retry timer for a specific shift
    clearRetryTimer(shiftId) {
        const timeoutId = this.retryTimers.get(shiftId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.retryTimers.delete(shiftId);
        }
    }

    // Clear all retry timers
    clearAllRetryTimers() {
        for (const [shiftId, timeoutId] of this.retryTimers.entries()) {
            clearTimeout(timeoutId);
        }
        this.retryTimers.clear();
    }


    // Add payment to tracking
    addPayment(shift, orderId, destWallet, amount) {
        if (!shift.id || !orderId || !destWallet || !amount) {
            throw new Error('Invalid parameters passed to addPayment');
        }
        const shiftId = shift.id;
        // Store in your existing mapping structure
        this.shiftMapping.set(shiftId, {
            status: 'waiting',
            orderId: orderId,
            amount: amount,
            wallet: destWallet,
            shift: shift,
            createdAt: new Date(),
            lastChecked: null,
            retries: 0
        });

        // Add to polling queue
        this.pollingQueue.add(shiftId);

        if (this.verbose) console.log(`[PaymentPoller] Added shift ${shiftId} for polling`);

        // Start polling if not already running
        if (!this.isPolling) {
            this.startPolling();
        }
    }


    // Start polling - event-driven approach
    startPolling() {
        if (this.isPolling) return;

        this.isPolling = true;

        // Clear any existing timer to prevent multiple simultaneous polls
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        if (this.verbose) console.log('[PaymentPoller] Starting payment polling');

        // Start the polling cycle
        this.pollOnce();
    }


    async processShift(shiftId, data, newStatus) {
        const paymentData = this.shiftMapping.get(shiftId);

        // Only update if status changed
        if (paymentData.status !== newStatus) {
            if (this.verbose) console.log(`[PaymentPoller] Status changed for ${shiftId}: ${paymentData.status} -> ${newStatus}`);

            // Update local mapping
            paymentData.shift = data;
            paymentData.status = newStatus;
            paymentData.lastChecked = new Date();

            // Process completed or expired payments
            try {
                if (newStatus === 'settled') {
                    await this.handleCompletedPayment(data, paymentData);
                    this.pollingQueue.delete(shiftId); // Remove from polling
                    this.clearRetryTimer(shiftId);
                    if (this.verbose) console.log(`[PaymentPoller] Removed ${shiftId} from polling queue`);
                } else if (newStatus === 'expired') {
                    await this.handleFailedPayment(data, paymentData);
                    this.pollingQueue.delete(shiftId); // Remove from polling
                    this.clearRetryTimer(shiftId);
                    if (this.verbose) console.log(`[PaymentPoller] Removed failed ${shiftId} from polling queue`);
                }
            } catch (error) {
                if (this.verbose) {
                    console.error(`[PaymentPoller] Error processing status change for shift ${shiftId}:`, error);
                }
                // Re-queue with retry if needed
                this.handleRetry(shiftId);
                return;
            }
        }
    }


    // Single polling execution - event-driven
    async pollOnce() {

        if (this.pollingQueue.size === 0) {
            if (this.verbose) console.log('[PaymentPoller] No payments to poll, stopping polling');
            this.isPolling = false;
            return;
        }

        if (this.verbose) console.log(`[PaymentPoller] Polling ${this.pollingQueue.size} payments...`);

        const activeShifts = Array.from(this.pollingQueue).filter(id => {
            const data = this.shiftMapping.get(id);
            return data; // && !['settled', 'expired'].includes(data.status);
        });

        if (activeShifts.length === 0) {
            if (this.verbose) console.log('[PaymentPoller] No active payments to poll, stopping polling');
            this.stopPolling();
            return;
        }

        try {
            const shiftData = await this.fetchShiftData(activeShifts);

            // Map shiftId -> data for easier access
            const shiftMap = new Map(shiftData.map(shift => [shift.id, shift]));

            for (const shiftId of activeShifts) {
                const data = shiftMap.get(shiftId);

                if (!data) {
                    if (this.verbose) console.warn(`[PaymentPoller] No data returned for shift ${shiftId}`);
                    continue;
                }

                const newStatus = data.status;

                if (this.verbose) console.log(`[PaymentPoller] Payment ${shiftId} status: ${newStatus}`);

                if (this.shiftMapping.has(shiftId)) {

                    await this.processShift(shiftId, data, newStatus);

                } else {
                    if (this.verbose) console.log(`[PaymentPoller] Unknown ${shiftId} inside polling queue`);
                }
            }


            // Schedule next polling cycle only if there are still payments to check
            if (this.pollingQueue.size > 0) {
                this.scheduleNextPoll();
            } else {
                if (this.verbose) console.log('[PaymentPoller] All payments processed, stopping polling');
                this.stopPolling();
            }
            await this.cleanupOldEntries();

        } catch (error) {
            if (this.verbose) console.error('[PaymentPoller] Error during polling:', error);

            // Retry logic per shift
            for (const shiftId of activeShifts) {
                this.handleRetry(shiftId);
            }

            // Prevent scheduling another full poll if we already handled retries above
            return;
        }
    }


    // Schedule next poll cycle
    scheduleNextPoll() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        this.pollTimer = setTimeout(() => {
            this.pollOnce();
        }, this.timeout);
    }

    // Stop polling manually
    stopPolling() {
        this.isPolling = false;

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.verbose) console.log('[PaymentPoller] Payment polling Stopped');
    }

    // Remove shift from polling
    removeShift(shiftId) {
        this.pollingQueue.delete(shiftId);
        this.shiftMapping.delete(shiftId);
        this.clearRetryTimer(shiftId);

        // If no more active shifts, stop main timer
        if (this.pollingQueue.size === 0 && this.pollTimer) {
            this.stopPolling();
        }

        if (this.verbose) {
            console.log(`[PaymentPoller] Removed shift ${shiftId} from polling`);
        }
    }

    // Fetch data for a specific shift
    async fetchShiftData(activeShifts) {
        try {
            let shiftData;
            // Use getShift() for one shift and getBulkShifts() for multiple shifts
            if (activeShifts.length === 1) {
                const shiftId = activeShifts[0];
                const data = await this.shiftProcessor.sideshift.getShift(shiftId);
                shiftData = [data]; // Wrap in array for consistent processing

            } else {
                shiftData = await this.shiftProcessor.sideshift.getBulkShifts(activeShifts);
            }
            return shiftData;

        } catch (error) {
            if (this.verbose) {
                console.error(`[PaymentPoller] Error fetching data for shifts ${activeShifts}:`, error);

                // Detect fetch failure due to network issues
                if (error.message.includes('fetch failed') || error.code === 'ECONNRESET' || error.errno === -3001) {
                    console.warn('[PaymentPoller] Network error detected, will retry later');
                }
            }

            // Return null so that we can retry the entire batch in pollOnce()
            return null;
        }
    }

    // Handle retries for a shift
    handleRetry(shiftId) {
        const paymentData = this.shiftMapping.get(shiftId);
        if (!paymentData) return;

        paymentData.retries += 1;
        if (this.verbose) console.log(`[PaymentPoller] Retry count for ${shiftId}: ${paymentData.retries}`);

        if (paymentData.retries <= this.maxRetries) {
            const delay = this.calculateBackoffDelay(paymentData.retries);

            // Clear any existing retry timer
            this.clearRetryTimer(shiftId);

            // Schedule new retry
            const timeoutId = setTimeout(() => {
                this.pollingQueue.add(shiftId); // Re-add to queue for retry
                this.pollOnce(); // Trigger immediate poll
            }, delay);

            this.retryTimers.set(shiftId, timeoutId);

            if (this.verbose) console.log(`[PaymentPoller] Scheduled retry ${paymentData.retries}/${this.maxRetries} for shift ${shiftId} in ${delay}ms`);

        } else {
            // Handle Retry Exceeded
            if (this.verbose) console.warn(`[PaymentPoller] Max retries exceeded for shift ${shiftId}`);
            this.handleRetryExceeded(shiftId);
        }
    }

    // Handle Retry Exceeded
    handleRetryExceeded(shiftId) {
        try {
            // Your processing logic here
            const paymentData = this.shiftMapping.get(shiftId);
            if (!paymentData) return;

            if (this.failedMapping.get(shiftId)) return;

            const orderId = paymentData.orderId;

            // Set failedMapping data
            this.failedMapping.set(shiftId, {
                ...paymentData,
                status: 'failed',
                failedAt: new Date()
            });
            const failedPaymentData = this.failedMapping.get(shiftId);

            if (this.verbose) console.warn(`[PaymentPoller] Shift ${shiftId} failed after ${(failedPaymentData.failedAt.getTime() - failedPaymentData.createdAt.getTime()) / (1000 * 60)} minutes and ${failedPaymentData.retries} retries. Removing from queue.`);

            this.removeShift(shiftId)
            this.resetCryptoPayment(orderId, shiftId, "Error_MaxRetryExceeded");
        } catch (err) {
            if (this.verbose) console.error(`[PaymentPoller] Error handleRetryExceeded ${shiftId}:`, err);
        }
    }


    // Stop specific shift polling with individual timer cleanup
    async stopPollingForShift(shiftId, reason = 'manual') {
        try {
            if (this.verbose) console.log(`[PaymentPoller] Stopping polling for shift ${shiftId} - ${reason}`);
            // Set failedMapping data
            const paymentData = this.shiftMapping.get(shiftId);
            this.failedMapping.set(shiftId, {
                ...paymentData,
                status: 'canceled',
                stoppedReason: reason,
                stoppedAt: new Date()
            });
            this.removeShift(shiftId);

        } catch (error) {
            if (this.verbose) console.error(error);
        }
    }


    // Clean up old entries that have been completed/failed for a while
    async cleanupOldEntries(maxAge = this.maxAge) {
        try {
            const now = Date.now();
            let cleanedCount = 0;

            for (const [shiftId, shiftData] of this.shiftMapping.entries()) {
                if (now - shiftData.createdAt > maxAge) {
                    this.removeShift(shiftId);
                    cleanedCount++;
                    if (this.verbose) console.log(`[PaymentPoller] Cleaned up old shift ${shiftId}`);
                }
            }

            if (this.verbose && cleanedCount > 0) {
                console.log(`[PaymentPoller] Cleaned up ${cleanedCount} old entries`);
            }
        } catch (err) {
            if (this.verbose) console.error(`[PaymentPoller] Error cleaning old entries: ${err}`);
            return false;
        }

        return true;
    }


    // Method to manually trigger a poll (optional - for testing/debugging)
    triggerPoll() {
        if (this.verbose) console.log('[PaymentPoller] Manually triggering poll');
        this.pollOnce();
    }

    // Get polling data
    getPollingShiftData(shiftId) {
        // Check if shift exists in mapping
        if (!this.shiftMapping.has(shiftId)) {
            return null;
        }

        const data = this.shiftMapping.get(shiftId);

        // Validate that the shift is still in the polling queue
        const isInQueue = this.pollingQueue.has(shiftId);

        if (!isInQueue) {
            return null;
        }

        // Return a shallow copy of the data
        return { ...data };
    }

    // Get failed shift data
    getFailedShiftData(shiftId) {
        if (!this.failedMapping.has(shiftId)) {
            return null;
        }

        const data = this.failedMapping.get(shiftId);

        return { ...data };
    }

    // Get current polling status
    getStatus() {
        return {
            isPolling: this.isPolling,
            activeShifts: this.pollingQueue.size,
            totalShifts: this.shiftMapping.size,
            maxRetries: this.maxRetries
        };
    }



    // Handle completed payments
    async handleCompletedPayment(shift, paymentData) {
        try {
            const shiftId = shift.id;

            // Your processing logic here

            if (this.verbose) console.log(`[PaymentPoller] Processing completed payment ${shiftId}`);
            const orderId = paymentData.orderId;
            if (paymentData.amount === shift.settleAmount && paymentData.wallet === shift.settleAddress) {
                await this.updateOrderStatus(orderId, 'completed', shiftId);
                if (this.verbose) console.log(`[PaymentPoller] Successfully processed completed payment ${shiftId}`);
            } else {
                throw new Error(`Error processing completed payment ${shiftId}:`)
            }

        } catch (error) {
            if (this.verbose) console.error(error);
        }
    }

    // Handle failed payments
    async handleFailedPayment(shift, paymentData) {
        try {
            const shiftId = shift.id;

            // Your processing logic here

            if (this.verbose) console.log(`[PaymentPoller] Processing failed payment ${shiftId}`);

            const orderId = paymentData.orderId;
            await this.updateOrderStatus(orderId, 'failed', shiftId);

            if (this.verbose) console.log(`[PaymentPoller] Successfully processed failed payment ${shiftId}`);
        } catch (error) {
            if (this.verbose) console.error(`[PaymentPoller] Error processing failed payment ${shiftId}:`, error);
        }
    }

    // Update your database with payment status
    async updateOrderStatus(orderId, status, shiftId) {
        // Your processing logic here

        if (status === "completed") {
            this.confirmCryptoPayment(orderId, shiftId);
            await this.sendPaymentConfirmation(orderId, shiftId);
        } else if (status === "failed") {
            this.resetCryptoPayment(orderId, shiftId, "failed");
            await this.sendPaymentFailureNotification(orderId, shiftId);
        } else {
            if (this.verbose) console.error(`[PaymentPoller] Error updating order ${orderId} to status: ${status} - Shift ID: ${shiftId}`);
        }
        if (this.verbose) console.log(`[PaymentPoller] Updated order ${orderId} to status: ${status} - Shift ID: ${shiftId}`);
    }

    // Send confirmation to customer
    async sendPaymentConfirmation(orderId, shiftId) {
        // Your notification logic here
        if (this.verbose) console.log(`[PaymentPoller] Sent confirmation for order ${orderId}, shift ${shiftId}`);
    }

    // Send failure notification
    async sendPaymentFailureNotification(orderId, shiftId) {
        // Your notification logic here
        if (this.verbose) console.log(`[PaymentPoller] Sent failure notification for order ${orderId}, shift ${shiftId}`);
    }

}

module.exports = PaymentPoller;
